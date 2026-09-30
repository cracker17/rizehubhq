// The brain service: keeps the vault clone current (webhook + poll fallback) and the index in step with it.
// Runs are serialised: a trigger during a run marks one follow-up run instead of queueing many.
import type { Store } from './store/types';
import type { Embedder } from './index/embed';
import { indexVault, type IndexReport } from './index/indexer';
import { head, isClone, lastAuthor, pull, type GitOptions } from './git/sync';

export interface ServiceDeps {
  store: Store;
  embedder: Embedder | null;
  git: GitOptions;
  log: (msg: string) => void;
}

export interface SyncRequest { reason: string; actor?: string; full?: boolean }

export interface BrainService {
  sync(req: SyncRequest): Promise<IndexReport | null>;
  /** fire-and-forget (webhook / poll): coalesces with a running sync */
  trigger(req: SyncRequest): void;
  status(): { running: boolean; lastReport: IndexReport | null; lastError: string | null; lastRunAt: string | null };
}

export function createBrainService(d: ServiceDeps): BrainService {
  let running: Promise<IndexReport | null> | null = null;
  let pending: SyncRequest | null = null;
  let lastReport: IndexReport | null = null;
  let lastError: string | null = null;
  let lastRunAt: string | null = null;
  let firstRun = true;

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
      if (!p.changed && !firstRun && !req.full && wasClone) return lastReport;
      firstRun = false;
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
    running = runOnce(req).finally(() => {
      running = null;
      if (pending) { const next = pending; pending = null; void sync(next).catch(() => {}); }
    });
    return running;
  }

  return {
    sync,
    trigger(req) { void sync(req).catch(() => {}); },
    status: () => ({ running: !!running, lastReport, lastError, lastRunAt }),
  };
}
