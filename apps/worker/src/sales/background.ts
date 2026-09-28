// Outreach work the worker loop does on its own (hooked from loop.ts, like rizehub/background.ts):
//   send     approved emails under today's cap (every minute; skipped while the CEO paused HQ)
//   inbox    IMAP replies → classify → record; opt-outs honoured even while paused
//   batch    at OUTREACH_BATCH_HOUR (Manila) the day's first-touch + follow-up drafts become ONE approval
//   follow   due follow-ups (day 3 / 7 / 14) → one request for the Sales Agent; day 21 → lost (no response)
//   status   settings.outreach_status for the dashboard (sent today vs cap, warm-up day, why sending is off)
import { errMsg, log, usageDetail, type WorkerDeps } from '../deps';
import { normalizeUsage } from '../models/usage';
import { sendingProblems } from './config';
import { pollInbox } from './inbox';
import { getSales, type SalesRuntime } from './runtime';
import { runSendTick, todayCap } from './sender';

type Logger = (msg: string, extra?: unknown) => void;

/** Manila date + hour for "is it batch time yet?". */
export function manilaClock(now: Date): { day: string; hour: number } {
  const day = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const hour = Number(now.toLocaleString('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', hourCycle: 'h23' }));
  return { day, hour };
}

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
  await rt.db.setSetting('outreach_status', {
    cap_today: cap, configured_cap: rt.cfg.cap, warmup_day: warmupDay, warmup_ramp: ramp, sent_today: sentToday,
    sending_enabled: sendingProblems(rt.cfg).length === 0 && !!rt.mailer, problems: sendingProblems(rt.cfg),
    inbox_enabled: !!rt.inbox, auto_approve_follow_ups: rt.cfg.autoApproveFollowUps, batch_hour: rt.cfg.batchHour,
    from: rt.cfg.fromEmail, updated_at: now.toISOString(),
  });
}

export interface SalesBackgroundOptions { runtime?: SalesRuntime; batchEveryMs?: number; followUpsEveryMs?: number; statusEveryMs?: number }

export function startSalesBackground(deps: WorkerDeps, o: SalesBackgroundOptions = {}): NodeJS.Timeout[] {
  const logf: Logger = (m, e) => log(deps, m, e);
  let rt: SalesRuntime;
  try { rt = o.runtime ?? getSales(); } catch (e) { logf('[sales] outreach disabled', errMsg(e)); return []; }
  const now = () => (deps.now ?? (() => new Date()))();
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>, runNow = false) => {
    if (!(ms > 0)) return;
    let busy = false;
    const run = () => {
      if (busy) return;
      busy = true;
      fn().catch((e) => logf(`[sales] ${name} failed`, errMsg(e))).finally(() => { busy = false; });
    };
    const t = setInterval(run, ms);
    t.unref?.();
    timers.push(t);
    if (runNow) run();
  };
  const paused = async () => { const v = (await deps.db.getSettings().catch(() => ({} as Record<string, unknown>))).paused; return v === true || v === 'true'; };
  let lastSentToday: number | null = null;

  every(rt.cfg.sendEveryMs, 'send', async () => {
    if (await paused()) return;
    const r = await runSendTick({ db: rt.db, mailer: rt.mailer, cfg: rt.cfg, now: now(), log: logf });
    if (r.status !== 'disabled') lastSentToday = r.sentToday;
  });
  if (rt.inbox) {
    const inbox = rt.inbox;
    every(rt.cfg.inboxEveryMs, 'inbox', () => pollInbox({
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
  every(o.batchEveryMs ?? 5 * 60_000, 'daily batch', () => maybeCreateDailyBatch(rt, now(), logf), true);
  every(o.followUpsEveryMs ?? 3_600_000, 'follow-ups', async () => {
    const r = await rt.db.queueFollowUps();
    if (r.queued || r.closed_no_response) logf(`[sales] follow-ups: ${r.queued} queued for drafting, ${r.closed_no_response} closed (no response)`);
  }, true);
  every(o.statusEveryMs ?? 5 * 60_000, 'status', () => writeOutreachStatus(rt, now(), lastSentToday), true);

  const problems = sendingProblems(rt.cfg);
  for (const w of rt.cfg.warnings) logf(`[sales] ${w}`);
  logf(problems.length
    ? `[sales] outreach sending is OFF: ${problems.join('; ')}`
    : `[sales] outreach from ${rt.cfg.fromEmail} · cap ${rt.cfg.cap}/day (warm-up ${rt.cfg.warmupStart} +${rt.cfg.warmupStepPerWeek}/week) · batch at ${rt.cfg.batchHour}:00 Manila`
      + `${rt.inbox ? '' : ' · IMAP not configured: replies are not read'}`);
  return timers;
}
