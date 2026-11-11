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
  /** chunks per embedding write (BRAIN_EMBED_BATCH) */
  embedBatch?: number;
  /** clock for tests */
  now?: () => Date;
}

/** Index more than this far behind the last pull → one Telegram alert (then at most every LAG_REALERT_MS). */
export const LAG_ALERT_MS = 60 * 60_000;
export const LAG_REALERT_MS = 6 * 60 * 60_000;

/** Sync-state status + error text for a finished run. Pure, so it is easy to test. */
export function runOutcome(report: Pick<IndexReport, 'blocked' | 'failed' | 'pendingEmbeddings' | 'embedError'>, hasEmbedder: boolean):
  { status: 'ok' | 'degraded'; error: string | null } {
  if (report.failed.length) {
    const f = report.failed[0];
    return { status: 'degraded', error: `${report.failed.length} file${report.failed.length === 1 ? '' : 's'} could not be indexed (first: ${f.path}: ${f.error})` };
  }
  if (report.embedError) return { status: 'degraded', error: `embedding paused until the next run: ${report.embedError}` };
  if (report.blocked.length || (hasEmbedder ? report.pendingEmbeddings > 0 : true)) return { status: 'degraded', error: null };
  return { status: 'ok', error: null };
}

/** Should a "brain index is behind" alert go out now? */
export function lagAlertDue(lastIndexAt: string | null, lastPullAt: string | null, lastAlertAt: string | null, now: Date): boolean {
  if (!lastPullAt) return false;
  const indexed = lastIndexAt ? Date.parse(lastIndexAt) : 0;
  if (now.getTime() - indexed < LAG_ALERT_MS) return false; // a complete index ran recently
  if (Date.parse(lastPullAt) <= indexed) return false;       // nothing new was pulled since, so not behind
  return !lastAlertAt || now.getTime() - Date.parse(lastAlertAt) >= LAG_REALERT_MS;
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

  /** Index stuck behind the vault for over an hour → one alert for the Telegram bot (brain_alerts), repeated every 6 h. */
  async function maybeAlertLag(): Promise<void> {
    const clock = d.now ?? (() => new Date());
    const h = await d.store.rpc<{ last_index_at: string | null; last_pull_at: string | null; error: string | null; lag_alerted_at?: string | null }>('brain_sync_state_row')
      .catch(() => null);
    if (!h || !lagAlertDue(h.last_index_at, h.last_pull_at, h.lag_alerted_at ?? null, clock())) return;
    const since = h.last_index_at ? new Date(h.last_index_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never';
    await d.store.rpc('brain_raise_alert', {
      p_kind: 'index_lagging',
      p_text: `HQ Brain index is behind the vault (last full index: ${since}). ${h.error ? `Last error: ${h.error.slice(0, 200)}` : ''}`.trim(),
      p_meta: { last_index_at: h.last_index_at, last_pull_at: h.last_pull_at },
    });
    await d.store.rpc('brain_set_sync_state', { p: { lag_alerted_at: clock().toISOString() } });
    d.log('alert: index lagging (sent to brain_alerts)');
  }

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
        actor: req.actor ?? 'brain-service', full: req.full, log: d.log, embedBatch: d.embedBatch,
      });
      const outcome = runOutcome(report, !!d.embedder);
      // last_index_at = the last *complete* index: a run with failed files leaves it alone, so the UI's VPS light and the
      // lag alert show that part of the vault is behind.
      await d.store.rpc('brain_set_sync_state', {
        p: {
          error: outcome.error, status: outcome.status, failed: report.failed.slice(0, 50),
          ...(report.failed.length ? {} : { last_index_at: now(), lag_alerted_at: null }),
        },
      });
      if (report.failed.length) await maybeAlertLag();
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
      await maybeAlertLag().catch(() => {});
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
