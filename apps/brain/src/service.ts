// The brain service: keeps the vault clone current (webhook + poll fallback) and the index in step with it.
// Runs are serialised: a trigger during a run marks one follow-up run instead of queueing many. Connector writes take
// the same lock, so a pull never lands in the middle of an edit, commit and push.
import type { Store } from './store/types';
import type { Embedder } from './index/embed';
import { indexVault, type IndexReport } from './index/indexer';
import { commitAndPush, head, isClone, lastAuthor, pull, resetToOrigin, type GitOptions } from './git/sync';
import { findSecret } from './secretScan';
import { WriteError, type VaultOp, type WriteResult } from './write/vault';
import fs from 'node:fs';
import path from 'node:path';

export interface ServiceDeps {
  store: Store;
  embedder: Embedder | null;
  git: GitOptions;
  log: (msg: string) => void;
  /** IANA zone for the dates written into the vault (BRAIN_TIMEZONE, default Asia/Manila) */
  timeZone?: string;
}

export interface SyncRequest { reason: string; actor?: string; full?: boolean }

export interface BrainService {
  sync(req: SyncRequest): Promise<IndexReport | null>;
  /** fire-and-forget (webhook / poll): coalesces with a running sync */
  trigger(req: SyncRequest): void;
  status(): { running: boolean; lastReport: IndexReport | null; lastError: string | null; lastRunAt: string | null };
  /** Run a vault edit on a fresh pull, commit + push it (re-running the edit if the PC pushed first), then re-index. */
  write(op: VaultOp, actor: string): Promise<WriteResult & { sha: string }>;
}

export const WRITE_ATTEMPTS = 3;

/** YYYY-MM-DD in the vault's time zone. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function createBrainService(d: ServiceDeps): BrainService {
  let running: Promise<IndexReport | null> | null = null;
  let pending: SyncRequest | null = null;
  let lastReport: IndexReport | null = null;
  let lastError: string | null = null;
  let lastRunAt: string | null = null;
  let firstRun = true;
  // A write's pull moved the tree but the index did not follow (the edit failed): the next sync must index anyway.
  let needsIndex = false;
  // One run at a time (syncs and writes): each waits for the one before it.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = tail.then(fn, fn);
    tail = r.catch(() => {});
    return r;
  };

  async function runOnce(req: SyncRequest): Promise<IndexReport | null> {
    const now = () => new Date().toISOString();
    try {
      const wasClone = isClone(d.git.dir);
      const p = await pull(d.git);
      await d.store.rpc('brain_set_sync_state', { p: { branch: d.git.branch, head_sha: p.to, last_pull_at: now() } });
      if (p.changed) {
        const author = await lastAuthor(d.git);
        await d.store.rpc('brain_log_event', {
          p_actor: req.actor ?? 'brain-service', p_action: 'pulled', p_project: null, p_path: null,
          p_summary: p.cloned ? `cloned at ${p.to.slice(0, 7)}` : `${(p.from ?? '').slice(0, 7)} → ${p.to.slice(0, 7)}${p.reset ? ' (reset: upstream history changed)' : ''}`,
          p_meta: { from: p.from, to: p.to, reset: p.reset, author, reason: req.reason },
        });
        d.log(`pulled ${p.cloned ? 'fresh clone' : `${p.from?.slice(0, 7)}..${p.to.slice(0, 7)}`} (${req.reason})`);
      }
      // Index when the tree moved, on the first run after boot (the DB may be behind the clone), or when asked to.
      if (!p.changed && !firstRun && !req.full && wasClone && !needsIndex) return lastReport;
      firstRun = false;
      needsIndex = false;
      const report = await indexVault({
        store: d.store, embedder: d.embedder, vaultDir: d.git.dir, gitSha: await head(d.git),
        actor: req.actor ?? 'brain-service', full: req.full, log: d.log,
      });
      await d.store.rpc('brain_set_sync_state', {
        p: {
          last_index_at: now(), error: null,
          status: report.blocked.length || (d.embedder ? report.pendingEmbeddings > 0 : true) ? 'degraded' : 'ok',
        },
      });
      lastReport = report;
      lastError = null;
      return report;
    } catch (e) {
      lastError = (e as Error).message;
      d.log(`sync failed (${req.reason}): ${lastError}`);
      await d.store.rpc('brain_set_sync_state', { p: { status: 'error', error: lastError } }).catch(() => {});
      await d.store.rpc('brain_log_event', {
        p_actor: 'brain-service', p_action: 'error', p_project: null, p_path: null, p_summary: lastError.slice(0, 500), p_meta: { reason: req.reason },
      }).catch(() => {});
      throw e;
    } finally {
      lastRunAt = now();
    }
  }

  async function sync(req: SyncRequest): Promise<IndexReport | null> {
    if (running) {
      pending = { ...req, full: req.full || pending?.full };
      await running.catch(() => {});
      if (running) return running;
    }
    running = exclusive(() => runOnce(req)).finally(() => {
      running = null;
      if (pending) { const next = pending; pending = null; void sync(next).catch(() => {}); }
    });
    return running;
  }

  async function writeOnce(op: VaultOp, actor: string): Promise<WriteResult & { sha: string }> {
    const zone = d.timeZone || 'Asia/Manila';
    let lastErr = '';
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      let pushed = false;
      try {
        if ((await pull(d.git)).changed) needsIndex = true; // clone if needed; drops a lost attempt's local commit
        const result = op(d.git.dir, todayIn(zone));
        for (const p of result.paths) {
          const abs = path.join(d.git.dir, ...p.split('/'));
          const hit = fs.existsSync(abs) ? findSecret(fs.readFileSync(abs, 'utf8')) : null;
          if (hit) throw new WriteError(`${p} would contain something that looks like a secret (${hit}); nothing was saved.`);
        }
        const out = await commitAndPush(d.git, result.paths, result.message, actor);
        if (!out.ok) {
          lastErr = out.error;
          if (out.rejected && attempt < WRITE_ATTEMPTS) { d.log(`write: push lost a race (attempt ${attempt}), retrying on the new tree`); continue; }
          throw new Error(out.rejected ? 'the vault kept changing while saving; try again in a minute' : `push failed: ${out.error}`);
        }
        pushed = true;
        await d.store.rpc('brain_log_event', {
          p_actor: actor, p_action: 'saved', p_project: result.project, p_path: result.paths[0] ?? null,
          p_summary: result.summary, p_meta: { sha: out.sha, paths: result.paths },
        });
        d.log(`write: ${result.message} (${out.sha.slice(0, 7)}) by ${actor}`);
        // Index right away so the next read sees it; a failure here is repaired by the next sync (the push is what counts).
        try {
          lastReport = await indexVault({ store: d.store, embedder: d.embedder, vaultDir: d.git.dir, gitSha: out.sha, actor, log: d.log });
          needsIndex = false;
          await d.store.rpc('brain_set_sync_state', { p: { head_sha: out.sha, last_index_at: new Date().toISOString() } });
        } catch (e) { needsIndex = true; d.log(`write: indexing after ${out.sha.slice(0, 7)} failed: ${(e as Error).message}`); }
        return { ...result, sha: out.sha };
      } finally {
        if (!pushed) await resetToOrigin(d.git).catch(() => {});
      }
    }
    throw new Error(`save failed: ${lastErr}`);
  }

  return {
    sync,
    write: (op, actor) => exclusive(() => writeOnce(op, actor)),
    trigger(req) { void sync(req).catch(() => {}); },
    status: () => ({ running: !!running, lastReport, lastError, lastRunAt }),
  };
}
