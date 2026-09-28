// Outreach work the worker does on its own (started from index.ts next to the WorkerLoop; stopped on shutdown):
//   send     approved emails under today's cap (every minute; skipped while the CEO paused HQ or in quiet hours)
//   inbox    IMAP replies → classify → record; opt-outs honoured even while paused
//   batch    at OUTREACH_BATCH_HOUR (Manila) the day's first-touch + follow-up drafts become ONE approval
//   follow   due follow-ups (day 3 / 7 / 14) → one request for the Sales Agent; day 21 → lost (no response)
//   status   settings.outreach_status for the dashboard (sent today vs cap, warm-up day, why sending is off)
// Fail safe: OUTREACH_ENABLED off → nothing starts. On but SMTP / sender / postal address missing → only the status row
// (so the dashboard can say why) and the inbox if IMAP is configured; no batches or follow-up requests are created for
// emails that could never be sent.
import { errMsg, log, usageDetail, type WorkerDeps } from '../deps';
import { normalizeUsage } from '../models/usage';
import { outreachConfig, sendingProblems, type OutreachConfig } from './config';
import { pollInbox } from './inbox';
import { getSales, type SalesRuntime } from './runtime';
import { manilaClock } from './schedule';
import { runSendTick, todayCap } from './sender';

export { manilaClock };

type Logger = (msg: string, extra?: unknown) => void;

/** Creates today's batch approval once the batch hour has passed (SQL makes it at most once per day). */
export async function maybeCreateDailyBatch(rt: Pick<SalesRuntime, 'db' | 'cfg'>, now: Date, logf: Logger = () => undefined): Promise<string | null> {
  const { day, hour } = manilaClock(now);
  if (hour < rt.cfg.batchHour) return null;
  const id = await rt.db.createDailyBatch(day, false);
  if (id) logf(`[sales] daily outreach batch ${day} is waiting for approval (${id})`);
  return id;
}

export async function writeOutreachStatus(rt: SalesRuntime, now: Date, sentToday: number | null): Promise<void> {
  const { cap, warmupDay, ramp } = await todayCap(rt.db, rt.cfg, now);
  const problems = sendingProblems(rt.cfg);
  await rt.db.setSetting('outreach_status', {
    cap_today: cap, configured_cap: rt.cfg.cap, warmup_day: warmupDay, warmup_ramp: ramp, sent_today: sentToday,
    sending_enabled: problems.length === 0 && !!rt.mailer, problems,
    inbox_enabled: !!rt.inbox, auto_approve_follow_ups: rt.cfg.autoApproveFollowUps, batch_hour: rt.cfg.batchHour,
    quiet_hours: rt.cfg.quietHours, from: rt.cfg.fromEmail, updated_at: now.toISOString(),
  });
}

export type SalesJob = 'send' | 'inbox' | 'batch' | 'follow_ups' | 'status';

/** Which background jobs may run with this config (pure; see the header for the rules). */
export function salesJobs(cfg: OutreachConfig, hasMailer: boolean, hasInbox: boolean): SalesJob[] {
  if (!cfg.enabled) return [];
  const canSend = hasMailer && sendingProblems(cfg).length === 0;
  const jobs: SalesJob[] = ['status'];
  if (hasInbox) jobs.push('inbox');
  if (canSend) jobs.push('send', 'batch', 'follow_ups');
  return jobs;
}

export interface SalesBackgroundOptions {
  runtime?: SalesRuntime;
  /** Config used to decide whether to start at all (default: the runtime's, else outreachConfig()). */
  cfg?: OutreachConfig;
  batchEveryMs?: number; followUpsEveryMs?: number; statusEveryMs?: number;
}

/** Starts the enabled outreach jobs. Returns their timers: pass them to stopSalesBackground() on shutdown. */
export function startSalesBackground(deps: WorkerDeps, o: SalesBackgroundOptions = {}): NodeJS.Timeout[] {
  const logf: Logger = (m, e) => log(deps, m, e);
  const cfg0 = o.cfg ?? o.runtime?.cfg ?? outreachConfig();
  if (!cfg0.enabled) { logf('[sales] outreach background off (OUTREACH_ENABLED is not true): drafting works, nothing is sent or polled'); return []; }
  let rt: SalesRuntime;
  try { rt = o.runtime ?? getSales(); } catch (e) { logf('[sales] outreach disabled', errMsg(e)); return []; }
  const jobs = new Set(salesJobs(rt.cfg, !!rt.mailer, !!rt.inbox));
  const now = () => (deps.now ?? (() => new Date()))();
  const timers: NodeJS.Timeout[] = [];
  const every = (job: SalesJob, ms: number, fn: () => Promise<unknown>, runNow = false) => {
    if (!jobs.has(job) || !(ms > 0)) return;
    let busy = false;
    const run = () => {
      if (busy) return;
      busy = true;
      fn().catch((e) => logf(`[sales] ${job} failed`, errMsg(e))).finally(() => { busy = false; });
    };
    const t = setInterval(run, ms);
    t.unref?.();
    timers.push(t);
    if (runNow) run();
  };
  const paused = async () => { const v = (await deps.db.getSettings().catch(() => ({} as Record<string, unknown>))).paused; return v === true || v === 'true'; };
  let lastSentToday: number | null = null;

  every('send', rt.cfg.sendEveryMs, async () => {
    if (await paused()) return;
    const r = await runSendTick({ db: rt.db, mailer: rt.mailer, cfg: rt.cfg, now: now(), log: logf });
    if (r.status !== 'disabled') lastSentToday = r.sentToday;
  });
  if (rt.inbox) {
    const inbox = rt.inbox;
    every('inbox', rt.cfg.inboxEveryMs, () => pollInbox({
      db: rt.db, source: inbox, cfg: rt.cfg, log: logf,
      classify: {
        pickModel: deps.pickModel, log: logf,
        onUsage: (u) => {
          const nu = normalizeUsage(u.provider, u.usage as never, u.providerMetadata as never);
          void deps.db.recordUsage({
            actor: 'sales', kind: 'chat', taskId: null, requestId: null, tokensIn: nu.inputTokens ?? 0, tokensOut: nu.outputTokens ?? 0,
            costUsd: u.costUsd, detail: usageDetail({ provider: u.provider, modelId: u.modelId }, nu, { purpose: 'sales.reply_classification' }),
          }).catch(() => undefined);
        },
      },
    }), true);
  }
  every('batch', o.batchEveryMs ?? 5 * 60_000, () => maybeCreateDailyBatch(rt, now(), logf), true);
  every('follow_ups', o.followUpsEveryMs ?? 3_600_000, async () => {
    const r = await rt.db.queueFollowUps();
    if (r.queued || r.closed_no_response) logf(`[sales] follow-ups: ${r.queued} queued for drafting, ${r.closed_no_response} closed (no response)`);
  }, true);
  every('status', o.statusEveryMs ?? 5 * 60_000, () => writeOutreachStatus(rt, now(), lastSentToday), true);

  const problems = sendingProblems(rt.cfg);
  for (const w of rt.cfg.warnings) logf(`[sales] ${w}`);
  logf(problems.length || !rt.mailer
    ? `[sales] outreach sending is OFF: ${(problems.length ? problems : ['no SMTP transport']).join('; ')}${rt.inbox ? ' · inbox polling on' : ''}`
    : `[sales] outreach from ${rt.cfg.fromEmail} · cap ${rt.cfg.cap}/day (warm-up ${rt.cfg.warmupStart} +${rt.cfg.warmupStepPerWeek}/week) · batch at ${rt.cfg.batchHour}:00 Manila`
      + `${rt.cfg.quietHours ? ` · quiet ${rt.cfg.quietHours.start}:00–${rt.cfg.quietHours.end}:00 Manila` : ''}`
      + `${rt.inbox ? '' : ' · IMAP not configured: replies are not read'}`);
  return timers;
}

/** Clears the timers startSalesBackground returned (idempotent: the array is emptied). */
export function stopSalesBackground(timers: NodeJS.Timeout[]): void {
  for (const t of timers.splice(0)) clearInterval(t);
}
