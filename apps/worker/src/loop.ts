// The worker loop (docs/05 [4]): each tick plans ≤ 1 staged request, claims tasks while under
// MAX_PARALLEL_TASKS, and runs ≤ 1 QA review. Planning and QA run single-flight in the background
// so a slow model call never blocks claiming.
import { errMsg, log, type WorkerDeps } from './deps';
import { runIdleShuffle } from './idle';
import { planNext } from './planner';
import { reviewNext } from './qa';
import { runDueReports } from './reportsJob';
import { runTask } from './runner';
import { startRizehubBackground } from './rizehub/background';
import { DailyBudgetGuard, freeFallbackNote, GlobalDailyBudget, globalBudgetNote, overBudgetNote, type GlobalBudgetCheck } from './budget';
import type { TaskRow } from './hqdb';

/** settings.paused may be stored as true or "true". */
export function isPausedSetting(v: unknown): boolean {
  return v === true || v === 'true';
}

export interface LoopOptions {
  pollIntervalMs: number;
  maxParallelTasks: number;
  staleEveryMs?: number;
  idleEveryMs?: number;
  quotaBackoffMs?: number;
  /** How often scheduled reports are checked (docs/05 "Scheduled work"). 0 disables. */
  reportsEveryMs?: number;
  /** How long a settings.paused read is trusted before re-reading. */
  pausedCheckMs?: number;
  /** Pause before claiming again when every claimable task belongs to an agent over its daily budget. */
  budgetBackoffMs?: number;
  /**
   * Daily AI cap: when today's total AI spend reaches it, no new planning, tasks or QA start (null → settings / none).
   * A function is read on every check (dashboard value → DAILY_AI_BUDGET_USD, settings/runtime.ts loopDailyBudget).
   */
  dailyBudgetUsd?: number | null | (() => number | null);
  /**
   * True when free-provider keys exist (router hasFreeProviderKey): at 100% of the daily budget only paid providers
   * stop and new work runs on the free profile. False/unset: nothing new starts until the next Manila day.
   */
  freeFallback?: boolean | (() => boolean);
  /** Every budget check result (the model picker blocks paid providers from it). */
  onDailySpend?: (g: GlobalBudgetCheck) => void;
}

export class WorkerLoop {
  readonly running = new Map<string, Promise<unknown>>();
  private controllers = new Map<string, AbortController>();
  private planning: Promise<unknown> | null = null;
  private reviewing: Promise<unknown> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private loopDone: Promise<void> | null = null;
  private pausedUntil = { tasks: 0, planning: 0, qa: 0 };
  private reporting: Promise<unknown> | null = null;
  private paused = { value: false, checkedAt: -Infinity };
  readonly budget: DailyBudgetGuard;
  readonly globalBudget: GlobalDailyBudget;
  private budgetStopDay: string | null = null;

  constructor(private deps: WorkerDeps, private opts: LoopOptions) {
    this.budget = new DailyBudgetGuard(deps.db, { now: deps.now });
    this.globalBudget = new GlobalDailyBudget(deps.db, { budgetUsd: opts.dailyBudgetUsd ?? null, now: deps.now, log: (m) => log(deps, m) });
  }

  /** True when today's total AI spend reached DAILY_AI_BUDGET_USD and no free models can take over: nothing new is claimed (logged once per day). */
  private async overDailyAiBudget(): Promise<boolean> {
    const g = await this.globalBudget.check().catch((e) => {
      log(this.deps, '[worker] daily AI budget check failed (work continues)', errMsg(e));
      return null;
    });
    if (g) this.opts.onDailySpend?.(g);
    if (!g?.over) return false;
    const ff = this.opts.freeFallback;
    const fallback = typeof ff === 'function' ? ff() : !!ff;
    if (this.budgetStopDay !== g.day) { this.budgetStopDay = g.day; log(this.deps, `[worker] ${fallback ? freeFallbackNote(g) : globalBudgetNote(g)}`); }
    return !fallback; // with free keys the picker skips paid providers and work goes on
  }

  private backoff(kind: keyof WorkerLoop['pausedUntil']) {
    this.pausedUntil[kind] = Date.now() + (this.opts.quotaBackoffMs ?? 60_000);
    log(this.deps, `[worker] ${kind} paused after a quota error`);
  }

  /** CEO pause (/pause, settings.paused): no new planning, tasks or QA; running work finishes. */
  async isPaused(): Promise<boolean> {
    const now = Date.now();
    if (now - this.paused.checkedAt < (this.opts.pausedCheckMs ?? 5_000)) return this.paused.value;
    try {
      const v = isPausedSetting((await this.deps.db.getSettings()).paused);
      if (v !== this.paused.value) log(this.deps, v ? '[worker] paused by the CEO: not claiming new work' : '[worker] resumed');
      this.paused = { value: v, checkedAt: now };
    } catch (e) {
      log(this.deps, '[worker] could not read settings.paused', errMsg(e));
      this.paused.checkedAt = now;
    }
    return this.paused.value;
  }

  /** Scheduled reports, single-flight. */
  runReports(): Promise<unknown> {
    if (!this.reporting) {
      this.reporting = runDueReports(this.deps)
        .catch((e) => log(this.deps, '[worker] reports failed', errMsg(e)))
        .finally(() => { this.reporting = null; });
    }
    return this.reporting;
  }

  async tick(): Promise<void> {
    if (await this.isPaused()) return;
    if (await this.overDailyAiBudget()) return;
    const now = Date.now();
    if (!this.planning && now >= this.pausedUntil.planning) {
      this.planning = planNext(this.deps)
        .then((o) => { if (o.status === 'deferred') this.backoff('planning'); })
        .catch((e) => log(this.deps, '[worker] planning failed', errMsg(e)))
        .finally(() => { this.planning = null; });
    }
    // Tasks of agents over their daily budget are held (still 'working', so claim_next_task skips them and the
    // queue behind them keeps moving) and re-queued with a note once this claim round is over.
    const held: { task: TaskRow; note: string }[] = [];
    let started = 0;
    try {
      while (!this.stopping && now >= this.pausedUntil.tasks && this.running.size < this.opts.maxParallelTasks && held.length < 20) {
        const task = await this.deps.db.claimNextTask();
        if (!task) break;
        const b = await this.budget.check(task.agent_id).catch((e) => {
          log(this.deps, `[worker] budget check for ${task.agent_id} failed (task runs)`, errMsg(e));
          return null;
        });
        if (b?.over) { held.push({ task, note: overBudgetNote(task, b) }); continue; }
        started++;
        log(this.deps, `[worker] ${task.agent_id} claimed "${task.title}"`);
        const ctrl = new AbortController();
        this.controllers.set(task.id, ctrl);
        const p = runTask(task, this.deps, { abortSignal: ctrl.signal })
          .then((r) => {
            log(this.deps, `[worker] ${task.agent_id} → ${r.status} ($${r.costUsd.toFixed(4)})`);
            if (r.status === 'requeued' && !this.stopping) this.backoff('tasks');
          })
          .catch((e) => log(this.deps, `[worker] task ${task.id} crashed`, errMsg(e)))
          .finally(() => { this.running.delete(task.id); this.controllers.delete(task.id); this.budget.invalidate(task.agent_id); this.globalBudget.invalidate(); });
        this.running.set(task.id, p);
      }
    } finally {
      for (const h of held) {
        log(this.deps, `[worker] ${h.note}`);
        await this.deps.db.requeueTask(h.task.id, h.note).catch((e) => log(this.deps, `[worker] could not re-queue ${h.task.id}`, errMsg(e)));
      }
      // Only over-budget work was claimable: don't re-claim (and re-log) it every poll.
      if (held.length && !started) this.pausedUntil.tasks = Date.now() + (this.opts.budgetBackoffMs ?? 5 * 60_000);
    }
    if (!this.reviewing && now >= this.pausedUntil.qa) {
      this.reviewing = reviewNext(this.deps)
        .then((o) => { if (o.status === 'deferred') this.backoff('qa'); })
        .catch((e) => log(this.deps, '[worker] QA failed', errMsg(e)))
        .finally(() => { this.reviewing = null; });
    }
  }

  start(): void {
    const every = (ms: number, fn: () => Promise<unknown>, name: string) => {
      this.timers.push(setInterval(() => { fn().catch((e) => log(this.deps, `[worker] ${name} failed`, errMsg(e))); }, ms));
    };
    every(this.opts.staleEveryMs ?? 60_000, async () => {
      const n = await this.deps.db.requeueStaleTasks();
      if (n) log(this.deps, `[worker] re-queued ${n} stale task(s)`);
    }, 'requeue_stale_tasks');
    every(this.opts.idleEveryMs ?? 90_000, () => runIdleShuffle(this.deps.db), 'idle shuffler');
    const reportsEvery = this.opts.reportsEveryMs ?? 60_000;
    if (reportsEvery > 0) {
      every(reportsEvery, () => this.runReports(), 'reports');
      void this.runReports(); // catch up right away after a restart
    }
    // RizeHub (M9b/M9c): webhook events, parked-job polling, approved publish/invite sends, job feeds + follow-ups.
    this.timers.push(...startRizehubBackground(this.deps));

    this.loopDone = (async () => {
      while (!this.stopping) {
        try { await this.tick(); } catch (e) { log(this.deps, '[worker] tick failed', errMsg(e)); }
        await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs));
      }
    })();
  }

  /** Stops claiming, aborts running tasks (they are re-queued, not failed) and waits for them. */
  async stop(timeoutMs = 20_000): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const c of this.controllers.values()) c.abort();
    const all = Promise.allSettled([...this.running.values(), this.planning, this.reviewing, this.reporting, this.loopDone].filter(Boolean));
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }
}
