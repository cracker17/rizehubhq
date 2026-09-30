// Runs scheduled reports (docs/05 "Scheduled work"): standups → CEO digest, morning brief and
// weekly summary, all written by the COO. The "reports" model role only rephrases; any model problem (no key, quota,
// bad output) falls back to the deterministic template so a report is always written.
import { generateObject, generateText } from 'ai';
import { Standup } from '@rizehubhq/shared';
import { errMsg, log, usageDetail, type WorkerDeps } from './deps';
import { isQuotaError, normalizeUsage, type PickedModel } from './models/usage';
import {
  activeAgentIds, acceptRewrite, buildDigest, buildMorningBrief, buildWeekly, digestMarkdown, morningMarkdown, standupMarkdown,
  templateStandup, weeklyMarkdown, type DayFacts, type StandupLines,
} from './reports';
import { addDays, dueJobs, reportKey, scheduleSettings, type ReportJob } from './reportsSchedule';

// ---------- phrasing (optional model) ----------
export class Phraser {
  private picked: PickedModel | null | undefined; // undefined = not tried yet, null = unavailable
  costUsd = 0;
  modelCalls = 0;

  constructor(private deps: WorkerDeps, private actor: string) {}

  private async model(): Promise<PickedModel | null> {
    if (this.picked !== undefined) return this.picked;
    try {
      const override = (await this.deps.db.getAgent(this.actor).catch(() => null))?.model_override ?? null;
      this.picked = await this.deps.pickModel('reports', { override });
    } catch (e) {
      log(this.deps, `[reports] no model for phrasing, using templates: ${errMsg(e)}`);
      this.picked = null;
    }
    return this.picked;
  }

  private async record(picked: PickedModel, raw: Parameters<PickedModel['recordCall']>[0], meta?: Parameters<PickedModel['recordCall']>[1]) {
    this.modelCalls++;
    const cost = picked.recordCall(raw, meta);
    const usage = normalizeUsage(picked.provider, raw, meta);
    this.costUsd += cost;
    await this.deps.db.recordUsage({
      actor: this.actor, kind: 'report', taskId: null, requestId: null,
      tokensIn: usage.inputTokens ?? 0, tokensOut: usage.outputTokens ?? 0, costUsd: cost, detail: usageDetail(picked, usage),
    }).catch((e) => log(this.deps, '[reports] usage log failed', errMsg(e)));
    return cost;
  }

  private fail(e: unknown, what: string, picked: PickedModel) {
    if (isQuotaError(e)) {
      this.picked = null; // stop trying for the rest of this run
      this.deps.onProviderQuota?.(picked.provider, { modelId: picked.modelId, error: e });
    }
    log(this.deps, `[reports] ${what} phrasing failed, using template: ${errMsg(e)}`);
  }

  /** Brief first-person rewrite of a standup; returns the template when the model is unavailable or strays. */
  async standup(name: string, tpl: StandupLines): Promise<{ lines: StandupLines; costUsd: number }> {
    if (!tpl.done.length && !tpl.next.length && !tpl.blockers.length) return { lines: tpl, costUsd: 0 };
    const picked = await this.model();
    if (!picked) return { lines: tpl, costUsd: 0 };
    try {
      const res = await generateObject({
        model: picked.model, schema: Standup, schemaName: 'standup',
        system: `You write ${name}'s end-of-day standup for the CEO of RizeHub, a web agency. First person, plain words, `
          + 'at most 14 words per item. Keep every fact (titles, clients, numbers). Never add work, results or blockers that are not listed. '
          + 'You may merge two items of the same section but never add items or leave a non-empty section empty.',
        prompt: `Rewrite these facts as a standup.\n${JSON.stringify(tpl, null, 2)}`,
      });
      const cost = await this.record(picked, res.usage, res.providerMetadata);
      const out = { done: res.object.done, next: res.object.next, blockers: res.object.blockers };
      if (!acceptRewrite(tpl, out)) { log(this.deps, `[reports] ${name}: rewrite changed the facts, using template`); return { lines: tpl, costUsd: cost }; }
      return { lines: out, costUsd: cost };
    } catch (e) {
      this.fail(e, `${name} standup`, picked);
      return { lines: tpl, costUsd: 0 };
    }
  }

  /** One-sentence headline; the template headline when unavailable. */
  async headline(kind: string, template: string, facts: unknown): Promise<string> {
    const picked = await this.model();
    if (!picked) return template;
    try {
      const res = await generateText({
        model: picked.model,
        system: `You write the one-sentence headline of RizeHub's ${kind} for the CEO. Max 30 words, plain text, no markdown. `
          + 'Use only the numbers given; mention what needs the CEO first. Never invent anything.',
        prompt: `Template headline: ${template}\n\nFacts:\n${JSON.stringify(facts).slice(0, 6000)}`,
      });
      await this.record(picked, res.usage, res.providerMetadata);
      const text = res.text.trim().replace(/^["“]|["”]$/g, '');
      return text && text.length <= 280 && !text.includes('\n') ? text : template;
    } catch (e) {
      this.fail(e, `${kind} headline`, picked);
      return template;
    }
  }
}

// ---------- jobs ----------
function agentNames(f: DayFacts): Map<string, string> {
  return new Map(f.agents.map((a) => [a.id, a.name]));
}

export interface JobResult { job: ReportJob; reportId: string | null; standups: number; costUsd: number; modelCalls: number }

/** Standups for every agent that worked on `date` (skips ones already written). Returns how many exist now. */
export async function writeStandups(date: string, f: DayFacts, deps: WorkerDeps, phraser: Phraser, existingAgents: Set<string>): Promise<number> {
  const names = agentNames(f);
  let count = 0;
  for (const agentId of activeAgentIds(f)) {
    if (existingAgents.has(agentId)) { count++; continue; }
    const name = names.get(agentId) ?? agentId;
    const tpl = templateStandup(agentId, f);
    const { lines, costUsd } = await phraser.standup(name, tpl);
    const agentSpend = Number(f.spend_by_actor.find((s) => s.actor === agentId)?.usd ?? 0);
    const id = await deps.db.saveReport({
      agentId, date, kind: 'standup', done: lines.done, next: lines.next, blockers: lines.blockers,
      bodyMd: standupMarkdown(name, lines), costUsd, data: { template: tpl, rephrased: lines !== tpl, spend_usd: agentSpend },
    });
    if (!id) log(deps, `[reports] standup ${agentId} ${date} already existed`);
    count++;
  }
  return count;
}

export async function runReportJob(job: ReportJob, deps: WorkerDeps, existing: { standupAgents?: Set<string> } = {}): Promise<JobResult> {
  const actor = 'coo'; // the COO owns every scheduled report (digest, morning brief, weekly)
  const phraser = new Phraser(deps, actor);
  const facts = await deps.db.reportFacts(job.from, job.days);
  const names = agentNames(facts);
  let standups = 0;
  let reportId: string | null;

  if (job.kind === 'daily_digest') {
    standups = await writeStandups(job.date, facts, deps, phraser, existing.standupAgents ?? new Set());
    // The digest day starts at midnight Manila (facts.from is the report date).
    const since = /^\d{4}-\d{2}-\d{2}$/.test(facts.from) ? `${facts.from}T00:00:00+08:00` : facts.from;
    const brain = deps.db.brainDigest ? await deps.db.brainDigest(since).catch(() => null) : null;
    const digest = buildDigest(facts, standups, brain);
    digest.headline = await phraser.headline('daily digest', digest.headline, { counts: digest.counts, qa: digest.qa, spend_usd: digest.spend_usd });
    reportId = await deps.db.saveReport({
      agentId: 'coo', date: job.date, kind: 'daily_digest',
      done: digest.done.map((d) => d.title), next: digest.in_progress.map((d) => d.title), blockers: digest.blocked.map((d) => `${d.title}: ${d.note ?? ''}`.trim()),
      bodyMd: digestMarkdown(job.date, digest, names), costUsd: phraser.costUsd, data: digest as unknown as Record<string, unknown>,
    });
  } else if (job.kind === 'morning_brief') {
    const y = await deps.db.reportFacts(addDays(job.date, -1), 1);
    const brief = buildMorningBrief(facts, { done: y.done.length, spend_usd: Number(y.spend_usd || 0) });
    reportId = await deps.db.saveReport({
      agentId: 'coo', date: job.date, kind: 'morning_brief',
      done: [], next: [...brief.in_progress, ...brief.queue].map((d) => d.title), blockers: brief.blocked.map((d) => d.title),
      bodyMd: morningMarkdown(job.date, brief, names), costUsd: 0, data: brief as unknown as Record<string, unknown>,
    });
  } else {
    const weekly = buildWeekly(facts);
    weekly.headline = await phraser.headline('weekly summary', weekly.headline, { ...weekly, qa_trend: undefined });
    reportId = await deps.db.saveReport({
      agentId: 'coo', date: job.date, kind: 'weekly',
      done: [`${weekly.done} tasks delivered`], next: [], blockers: weekly.bottlenecks,
      bodyMd: weeklyMarkdown(weekly, names), costUsd: phraser.costUsd, data: weekly as unknown as Record<string, unknown>,
    });
  }
  return { job, reportId, standups, costUsd: phraser.costUsd, modelCalls: phraser.modelCalls };
}

/** One scheduler pass: work out what is due (with catch-up) and write it. Never throws for a single job. */
export async function runDueReports(deps: WorkerDeps, now = (deps.now ?? (() => new Date()))()): Promise<JobResult[]> {
  const settings = scheduleSettings(await deps.db.getSettings());
  const since = addDays(now.toISOString().slice(0, 10), -10);
  const rows = await deps.db.existingReports(since);
  const existing = new Set(rows.filter((r) => r.kind !== 'standup').map((r) => reportKey(r.kind, r.report_date)));
  const results: JobResult[] = [];
  for (const job of dueJobs(now, settings, existing)) {
    const standupAgents = new Set(rows.filter((r) => r.kind === 'standup' && r.report_date === job.date && r.agent_id).map((r) => r.agent_id!));
    try {
      const r = await runReportJob(job, deps, { standupAgents });
      log(deps, `[reports] ${job.kind} ${job.date} written${r.standups ? ` (${r.standups} standups)` : ''} · ${r.modelCalls} model call(s) · $${r.costUsd.toFixed(4)}`);
      results.push(r);
    } catch (e) {
      log(deps, `[reports] ${job.kind} ${job.date} failed`, errMsg(e));
    }
  }
  return results;
}
