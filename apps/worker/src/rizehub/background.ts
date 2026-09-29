// RizeHub work the worker loop does on its own (hooked from loop.ts):
// 1. process stored webhook events (job.completed → resume parked task, client.signed_up → onboarding request, …)
// 2. poll RizeHub jobs that parked a task, in case a webhook was missed ("or HQ polls GET /jobs/{id}", docs/12)
// 3. execute approved non-pausing external actions (report publish, invite send) exactly once
// 4. queue job follow-up requests that came due; import public job-feed candidates (Sales Agent job-search, docs/13 §2)
import { errMsg, log, type WorkerDeps } from '../deps';
import type { HqDb } from '../hqdb';
import { toRizehubError, type RizehubClient } from './client';
import { getRizehub } from './config';
import { fetchJobFeeds, type FetchFeedsOptions } from './jobSources';
import type { ActionApprovalRow } from './store';
import { bindRizehubWebhook } from './webhookRoute';

type Logger = (msg: string, extra?: unknown) => void;

export async function processWebhookEvents(db: HqDb, logf: Logger = () => undefined, limit = 20): Promise<number> {
  let n = 0;
  for (const ev of await db.listUnprocessedWebhookEvents(limit)) {
    try {
      const r = await db.processRizehubEvent(ev.id);
      n++;
      logf(`[rizehub] ${ev.event} → ${String(r.action ?? 'done')}${r.outcome ? ` (${String(r.outcome)})` : ''}`);
    } catch (e) { logf(`[rizehub] webhook ${ev.id} (${ev.event}) failed`, errMsg(e)); }
  }
  return n;
}

export async function pollPendingJobs(db: HqDb, client: RizehubClient, logf: Logger = () => undefined, minAgeMs = 20_000): Promise<number> {
  let n = 0;
  const refs = await db.listRizehubRefs({ pendingJobs: true, limit: 20 });
  for (const ref of refs) {
    if (Date.now() - Date.parse(ref.updated_at) < minAgeMs) continue; // the tool may still be waiting inline
    try {
      const job = await client.getJob({ taskId: ref.task_id ?? 'system', agentId: 'hq-worker' }, ref.rizehub_id, 'READONLY');
      if (job.status !== 'completed' && job.status !== 'failed') continue;
      const r = await db.rizehubJobFinished(job.id, job.status, { ...(job.result ?? {}), ...(job.error ? { error: job.error } : {}) });
      n++;
      logf(`[rizehub] job ${job.id} ${job.status} (polled) → ${r}`);
    } catch (e) { logf(`[rizehub] polling job ${ref.rizehub_id} failed`, errMsg(e)); }
  }
  return n;
}

/**
 * External action types the worker executes itself after approval (report publish / invite send here; onboarding
 * inside its resumed task, tools/rizehub.ts; gmail.send in connectors/gmailSend.ts). Every other approved action type is
 * a MANUAL step for the CEO. Agents can't queue these through request_external_action (runner.ts refuses them).
 */
export const WORKER_EXECUTED_ACTIONS: ReadonlySet<string> = new Set(['rizehub.report_publish', 'rizehub.invite_send', 'rizehub.onboarding', 'gmail.send', 'mcp.call']);

const MAX_ATTEMPTS = 3;
/** Approved rizehub.report_publish / rizehub.invite_send actions → the real call, once. Onboarding runs in its task. */
export async function executeApprovedActions(db: HqDb, client: RizehubClient, logf: Logger = () => undefined): Promise<number> {
  let n = 0;
  const list: ActionApprovalRow[] = await db.listApprovedRizehubActions(10);
  for (const ap of list) {
    const type = String(ap.payload.action_type ?? '');
    const spec = ((ap.payload.spec as Record<string, unknown> | undefined)?.rizehub ?? {}) as Record<string, unknown>;
    if (type === 'rizehub.onboarding' || !ap.task_id) continue;
    const lastErr = ap.payload.last_error as { retryable?: boolean } | undefined;
    if (Number(ap.payload.attempts ?? 0) >= MAX_ATTEMPTS || (lastErr && lastErr.retryable === false)) continue;
    if (!(await db.externalActionExec(ap.id, 'claim'))) continue;
    const ctx = { taskId: ap.task_id, agentId: ap.agent_id ?? 'hq-worker' };
    try {
      let result: Record<string, unknown>;
      if (type === 'rizehub.report_publish' && typeof spec.report_id === 'string') {
        const rep = await client.publishReport(ctx, spec.report_id, { notify_client: spec.notify_client === true }).catch((e) => {
          if (toRizehubError(e).code === 'report_published') return null; // already done (e.g. an earlier attempt)
          throw e;
        });
        await db.recordRizehubRef({ taskId: null, kind: 'report', rizehubId: spec.report_id, summary: { status: 'published', published_at: new Date().toISOString(), publish_approval_id: ap.id } });
        result = { report_id: spec.report_id, status: 'published', preview_url: rep && 'preview_url' in rep ? rep.preview_url : spec.preview_url ?? null };
      } else if (type === 'rizehub.invite_send' && typeof spec.invite_id === 'string') {
        await client.sendInvite(ctx, spec.invite_id).catch((e) => {
          if (toRizehubError(e).code === 'invite_already_sent') return null;
          throw e;
        });
        await db.recordRizehubRef({ taskId: null, kind: 'invite', rizehubId: spec.invite_id, summary: { status: 'sent', sent_at: new Date().toISOString() } });
        result = { invite_id: spec.invite_id, status: 'sent' };
      } else {
        await db.externalActionExec(ap.id, 'failed', { code: 'unsupported_action', message: `No executor for ${type}`, retryable: false });
        continue;
      }
      await db.externalActionExec(ap.id, 'done', result);
      n++;
      logf(`[rizehub] executed ${type} (approval ${ap.id})`);
    } catch (e) {
      await db.externalActionExec(ap.id, 'failed', { ...toRizehubError(e).toJSON() }).catch(() => false);
      logf(`[rizehub] ${type} (approval ${ap.id}) failed`, errMsg(e));
    }
  }
  return n;
}

/** New public-feed jobs go in as `found` (no score yet); the Sales Agent screens them in its next job-search task. */
export async function importJobFeeds(db: HqDb, fetchFeeds: (o: FetchFeedsOptions) => ReturnType<typeof fetchJobFeeds> = fetchJobFeeds,
  logf: Logger = () => undefined, maxNew = 30): Promise<number> {
  const res = await fetchFeeds({ sinceDays: 7, limit: 150 });
  const failed = res.sources.filter((s) => !s.ok);
  if (failed.length) logf(`[rizehub] job feeds skipped: ${failed.map((s) => `${s.id} (${s.error})`).join(', ')}`);
  if (!res.items.length) return 0;
  const known = new Set((await db.listJobOpportunities({ urls: res.items.map((i) => i.url), limit: 500 })).map((j) => j.url));
  let n = 0;
  for (const it of res.items) {
    if (known.has(it.url) || n >= maxNew) continue;
    try {
      await db.upsertJobOpportunity({
        url: it.url, title: it.title, company: it.company, source: it.source, platform_tags: it.platform_tags, rate: it.rate,
        posted_at: it.posted_at, status: 'found', notes: it.summary ? `Feed summary: ${it.summary.slice(0, 300)}` : null,
      }, null);
      n++;
    } catch (e) { logf(`[rizehub] could not import ${it.url}`, errMsg(e)); }
  }
  if (n) logf(`[rizehub] imported ${n} new job(s) from public feeds`);
  return n;
}

export interface BackgroundOptions {
  eventsEveryMs?: number;       // webhooks + approved actions (default 5 s)
  pollJobsEveryMs?: number;     // missed-webhook job polling (default 30 s)
  followUpsEveryMs?: number;    // due job follow-ups (default 1 h)
  feedsEveryMs?: number;        // public job feeds (default 6 h; 0 disables)
  client?: RizehubClient;
}

function num(v: string | undefined, fallback: number) { return v === undefined || v === '' ? fallback : Number(v); }

/** Starts the RizeHub timers; returns them so the loop clears them on stop. Each job is single-flight. */
export function startRizehubBackground(deps: WorkerDeps, o: BackgroundOptions = {}): NodeJS.Timeout[] {
  const rz = getRizehub();
  const client = o.client ?? rz.client;
  bindRizehubWebhook(deps.db, rz.cfg.webhookSecret);
  const logf: Logger = (m, e) => log(deps, m, e);
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>, runNow = false) => {
    if (!(ms > 0)) return;
    let busy = false;
    const run = () => {
      if (busy) return;
      busy = true;
      fn().catch((e) => logf(`[rizehub] ${name} failed`, errMsg(e))).finally(() => { busy = false; });
    };
    const t = setInterval(run, ms);
    t.unref?.();
    timers.push(t);
    if (runNow) run();
  };
  // CEO pause (/pause, settings.paused): webhooks are still recorded, but nothing is executed and no feeds are pulled.
  const paused = async () => { const v = (await deps.db.getSettings().catch(() => ({} as Record<string, unknown>))).paused; return v === true || v === 'true'; };
  every(o.eventsEveryMs ?? num(process.env.RIZEHUB_EVENTS_EVERY_MS, 5_000), 'events', async () => {
    await processWebhookEvents(deps.db, logf);
    if (!(await paused())) await executeApprovedActions(deps.db, client, logf);
  }, true);
  every(o.pollJobsEveryMs ?? num(process.env.RIZEHUB_JOB_POLL_MS, 30_000), 'job polling', () => pollPendingJobs(deps.db, client, logf));
  every(o.followUpsEveryMs ?? 3_600_000, 'job follow-ups', async () => {
    const n = await deps.db.queueJobFollowUps();
    if (n) logf(`[rizehub] queued ${n} job follow-up request(s)`);
  }, true);
  every(o.feedsEveryMs ?? num(process.env.JOB_FEEDS_EVERY_MS, 6 * 3_600_000), 'job feeds', async () => { if (!(await paused())) await importJobFeeds(deps.db, fetchJobFeeds, logf); });
  logf(`[rizehub] ${rz.cfg.mock ? 'using the in-memory mock RizeHub (RIZEHUB_API_URL unset)' : `Agent API ${rz.cfg.baseUrl}`}`
    + `${rz.cfg.webhookSecret ? '' : ' · RIZEHUB_WEBHOOK_SECRET not set: /hooks/rizehub answers 503'}`);
  return timers;
}
