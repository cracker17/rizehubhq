// Worker mode's loops (docs/17-OPERATOR.md "Worker mode"). Framework-free and dependency-injected; tested with fakes.
//
//   job      claim one queued job (SQL refuses while paused), run the agent with the client's browser + tools, record
//            the outcome (finished → QA; waiting → its approvals; blocked → escalated; error → retry / failed)
//   verify   QA every link the job reported (375 / 1366 px, console, requests, overflow, links): pass → done (client
//            update queued through the 'status' tier + memories proposed to the Brain); fail → next run with the findings
//   action   execute one APPROVED outside-world action (API call or the exact browser click), re-checked against pauses
//   update   post one approved client update in the client's chat (same composer checks as replies)
import type { Gate } from '../ai';
import type { BrainBundle, BrainHit, OperatorChannel, OperatorClient, OperatorDb } from '../db';
import type { ChatDriver } from '../operator';
import { formatMemory, searchQuery } from '../prompt';
import { MaybeSentError } from '../browser/googleChat';
import type { NetEnv } from 'worker/src/research/net';
import { executeApiAction, type ApiEnv } from './apis';
import { JobBrowser, type WithContext } from './browser';
import type { JobDb } from './db';
import { checkBrowseUrl } from './guards';
import { buildJobPrompt, JOB_SYSTEM_PROMPT, type JobActionRow, type JobRow } from './prompt';
import { qaFeedback, qaSummary, qaTargets, qaVerdict, type QaReport } from './qa';
import type { JobRunOutcome } from './runner';
import { JobToolbox, type ToolSpec, type RunEnd } from './tools';

export interface AgentCall { prompt: string; systemPrompt: string; tools: ToolSpec[]; ended: () => RunEnd | null; model: string; apiKey: string; capUsd: number }

export interface JobLoopDeps {
  db: JobDb;
  op: Pick<OperatorDb, 'clients' | 'channels' | 'brainBundle' | 'brainSearch' | 'recordUsage'>;
  /** The client's workspace browser, under its profile lock, one call at a time. */
  withProfile: (profile: string) => WithContext;
  gate: () => Promise<Gate>;
  runAgent: (c: AgentCall) => Promise<JobRunOutcome>;
  qa: (urls: string[], withCtx: WithContext) => Promise<QaReport>;
  api: ApiEnv;
  net: NetEnv;
  chat: Pick<ChatDriver, 'send'>;
  terminal?: (jobId: string) => (command: string, cwd?: string, timeoutS?: number) => Promise<string>;
  sends: boolean;
  now?: () => number;
  log?: (m: string) => void;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);

export class JobLoop {
  private lastGateLog = { reason: '', at: 0 };
  constructor(private d: JobLoopDeps) {}

  private now() { return (this.d.now ?? Date.now)(); }
  private log(m: string) { (this.d.log ?? console.log)(m); }

  private async lookups() {
    const [clients, channels] = await Promise.all([this.d.op.clients(), this.d.op.channels()]);
    return { clients: new Map(clients.map((c) => [c.slug, c])), channels };
  }

  private async memory(client: OperatorClient, query: string): Promise<string> {
    if (!client.brain_project) return formatMemory(null, []);
    let bundle: BrainBundle | null = null; let hits: BrainHit[] = [];
    try { bundle = await this.d.op.brainBundle(client.brain_project); } catch (e) { this.log(`[operator] brain bundle: ${errMsg(e)}`); }
    const q = searchQuery(query);
    if (q) { try { hits = await this.d.op.brainSearch(client.brain_project, q, 6); } catch (e) { this.log(`[operator] brain search: ${errMsg(e)}`); } }
    return formatMemory(bundle, hits);
  }

  // ---------- job ----------

  /** Runs at most one job run. Returns the job's new status, or null when nothing ran. */
  async jobTick(): Promise<string | null> {
    const g = await this.d.gate();
    if (!g.ok) {
      if (g.reason !== this.lastGateLog.reason || this.now() - this.lastGateLog.at > 30 * 60_000) {
        this.lastGateLog = { reason: g.reason, at: this.now() };
        this.log(`[operator] jobs wait: ${g.reason}`);
      }
      return null;
    }
    const job = await this.d.db.claimJob();
    if (!job) return null;
    const { clients } = await this.lookups();
    const client = clients.get(job.client_slug);
    if (!client) return this.d.db.runDone(job.id, 'error', {}, 0, 'client is disabled');

    const step = (action: string, detail: Record<string, unknown> = {}) => this.d.db.step(job.id, action, detail).catch(() => undefined);
    const withCtx = this.d.withProfile(client.profile);
    const browser = new JobBrowser(withCtx, { step });
    const [memory, recentWork, actions] = await Promise.all([
      this.memory(client, `${job.title} ${job.brief}`),
      this.d.db.recentWork(client.slug, 10).catch(() => []),
      this.d.db.actions(job.id).catch(() => [] as JobActionRow[]),
    ]);
    const box = new JobToolbox({
      job, client, browser, withCtx, net: this.d.net, api: this.d.api, step,
      requestAction: (kind, summary, spec) => this.d.db.requestAction(job.id, kind, summary, spec),
      saveEvidence: (label, url, jpeg) => this.d.db.saveEvidence(job.id, label, url, jpeg),
      memorySearch: async (q) => (client.brain_project
        ? (await this.d.op.brainSearch(client.brain_project, q, 8)).map((h) => `- [${h.kind}] ${h.title}${h.heading ? ` › ${h.heading}` : ''}: ${h.text.slice(0, 700)}`).join('\n') || 'Nothing found.'
        : 'This client has no project in the HQ Brain.'),
      terminal: this.d.terminal?.(job.id),
    });
    const tools = box.specs();
    const prompt = buildJobPrompt({ client, job, memory, recentWork, actions, tools: tools.map((t) => t.name) });
    await step('job.run_started', { run: job.runs });
    let out: JobRunOutcome;
    try {
      out = await this.d.runAgent({ prompt, systemPrompt: JOB_SYSTEM_PROMPT, tools, ended: () => box.ended, model: g.model, apiKey: g.apiKey, capUsd: g.capUsd });
    } catch (e) {
      out = { outcome: 'error', end: box.ended, error: errMsg(e), costUsd: 0, tokensIn: 0, tokensOut: 0, model: g.model, turns: null };
    } finally {
      await browser.close();
    }
    if (out.costUsd > 0 || out.tokensIn > 0) {
      await this.d.op.recordUsage({ tokensIn: out.tokensIn, tokensOut: out.tokensOut, costUsd: out.costUsd,
        detail: { model: out.model, job_id: job.id, client: client.slug, runtime: 'operator-job', turns: out.turns, outcome: out.outcome } }).catch(() => undefined);
    }
    const f = out.end?.kind === 'finished' ? out.end.finish : null;
    const result = f ? { ...f, evidence: box.evidence } : {};
    const status = await this.d.db.runDone(job.id, out.outcome, result, out.costUsd, out.error);
    this.log(`[operator] job ${job.id.slice(0, 8)} (${client.slug}) run ${job.runs}: ${out.outcome}${out.error ? ` (${out.error})` : ''} → ${status}`);
    if (status === 'verifying') return this.verify(job.id);
    return status;
  }

  // ---------- verify ----------

  async verify(jobId: string): Promise<string> {
    const job = await this.d.db.job(jobId);
    if (!job || job.status !== 'verifying') return 'not_verifying';
    const { clients } = await this.lookups();
    const client = clients.get(job.client_slug);
    const urls = qaTargets(job.result?.links);
    let status: string;
    if (!client || !urls.length) {
      status = await this.d.db.verified(job.id, true, { pass: true, note: urls.length ? 'client disabled: not checked' : 'no links to check', errors: [], evidence: strings(job.result?.evidence) }, null);
    } else {
      await this.d.db.step(job.id, 'qa.run', { urls }).catch(() => undefined);
      let report: QaReport;
      try { report = await this.d.qa(urls, this.d.withProfile(client.profile)); }
      catch (e) { report = { pages: urls.map((u) => ({ url: u, finalUrl: u, status: null, title: '', consoleErrors: [], failedRequests: [], overflow: null, shots: [], error: errMsg(e) })), links: [] }; }
      const evidence: number[] = [];
      for (const p of report.pages) for (const s of p.shots) {
        const id = await this.d.db.saveEvidence(job.id, `QA ${s.width}px`, p.finalUrl, s.jpeg).catch(() => null);
        if (id) evidence.push(id);
      }
      const v = qaVerdict(report);
      status = await this.d.db.verified(job.id, v.pass, qaSummary(report, v, evidence), v.pass ? null : qaFeedback(v));
      this.log(`[operator] job ${job.id.slice(0, 8)} QA ${v.pass ? 'passed' : `failed (${v.errors.length})`} → ${status}`);
    }
    if (status === 'done') await this.afterDone(job);
    return status;
  }

  /** stale 'verifying' jobs (a restart between finish and QA). */
  async verifyStaleTick(): Promise<number> {
    const stale = await this.d.db.staleVerifying(10 * 60_000);
    for (const j of stale) await this.verify(j.id).catch((e) => this.log(`[operator] verify ${j.id.slice(0, 8)}: ${errMsg(e)}`));
    return stale.length;
  }

  /** Done: the client update (through the tiers) and the job's memories (Brain proposals). Each part best effort. */
  private async afterDone(job: JobRow): Promise<void> {
    const r = job.result ?? {};
    const update = typeof r.client_update === 'string' ? r.client_update.trim() : '';
    if (update) {
      try { this.log(`[operator] job ${job.id.slice(0, 8)} client update → ${await this.d.db.queueUpdate(job.id, update, strings(r.mentions))}`); }
      catch (e) { this.log(`[operator] client update: ${errMsg(e)}`); }
    }
    const links = strings(r.links);
    const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
    const memories: [('session_note' | 'decision' | 'next_step'), string][] = [];
    if (summary) memories.push(['session_note', `Operator job "${job.title}": ${summary}${links.length ? ` Links: ${links.join(' ')}` : ''}`.slice(0, 2000)]);
    for (const d of strings(r.decisions).slice(0, 5)) memories.push(['decision', d.slice(0, 2000)]);
    for (const n of strings(r.next_steps).slice(0, 5)) memories.push(['next_step', n.slice(0, 2000)]);
    for (const [kind, text] of memories) {
      try { await this.d.db.proposeMemory(job.id, kind, text); }
      catch (e) { this.log(`[operator] memory (${kind}): ${errMsg(e)}`); break; }
    }
    await this.d.db.promoteMemory().catch(() => 0);
  }

  // ---------- approved actions ----------

  async actionTick(): Promise<string | null> {
    const x = await this.d.db.claimAction();
    if (!x) return null;
    const why = await this.d.db.actionMayRun(x.id);
    if (why) return this.d.db.actionDone(x.id, false, {}, `not run: ${why}`);
    let out: { ok: boolean; result: Record<string, unknown>; error: string | null };
    if (x.kind === 'browser_click') {
      const { clients } = await this.lookups();
      const client = clients.get(x.client_slug);
      out = client ? await this.click(x, this.d.withProfile(client.profile)) : { ok: false, result: {}, error: 'client is disabled' };
    } else {
      out = await executeApiAction(this.d.api, x);
    }
    const status = await this.d.db.actionDone(x.id, out.ok, out.result, out.error);
    this.log(`[operator] action ${x.kind} (${x.client_slug}): ${out.ok ? 'done' : `failed: ${out.error}`}`);
    return status;
  }

  /** The exact approved click (spec: url, selector, text, type_text?, press?), with a screenshot after. Never retried. */
  private async click(x: JobActionRow, withCtx: WithContext): Promise<{ ok: boolean; result: Record<string, unknown>; error: string | null }> {
    const s = x.spec as { url?: string; selector?: string; text?: string; type_text?: string; press?: string };
    try {
      if (!s.url || !s.selector) throw new Error('the spec needs url and selector');
      const url = checkBrowseUrl(s.url).toString();
      return await withCtx(async (ctx) => {
        const page = await ctx.newPage();
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
          let target = page.locator(s.selector!);
          if (s.text?.trim()) target = target.filter({ hasText: s.text.trim() });
          const n = await target.count();
          if (n !== 1) throw new Error(`expected exactly one "${s.text ?? s.selector}" on ${page.url()}, found ${n}: not clicked`);
          if (s.type_text) await target.fill(s.type_text, { timeout: 15_000 });
          if (s.press) await target.press(s.press, { timeout: 15_000 }); else if (!s.type_text) await target.click({ timeout: 15_000 });
          await page.waitForTimeout(3000);
          const shot = await page.screenshot({ type: 'jpeg', quality: 55 }).catch(() => null);
          const evidence = shot ? await this.d.db.saveEvidence(x.job_id, `after: ${x.summary.slice(0, 80)}`, page.url(), shot).catch(() => null) : null;
          return { ok: true, result: { clicked: s.text ?? s.selector, now_at: page.url(), evidence }, error: null };
        } finally { await page.close().catch(() => undefined); }
      });
    } catch (e) {
      return { ok: false, result: {}, error: errMsg(e) };
    }
  }

  // ---------- client updates ----------

  async updateTick(): Promise<string | null> {
    if (!this.d.sends) return null;
    const o = await this.d.db.claimUpdate();
    if (!o) return null;
    const { clients, channels } = await this.lookups();
    const client = clients.get(o.client_slug);
    const channel: OperatorChannel | undefined = channels.find((c) => c.id === o.channel_id);
    const text = (o.final_text ?? '').trim();
    if (!client || !channel || !text) return this.d.db.updateDone(o.id, false, !text ? 'no approved text' : 'client or chat is disabled', {}, true);
    const msg = o.inbox_id ? await this.d.db.inboxMessage(o.inbox_id).catch(() => null) : null;
    const mentions = strings(o.mentions);
    try {
      const r = await this.d.chat.send(client, channel, { externalId: msg?.external_id ?? 'h:none', threadKey: msg?.thread_key ?? null, text, mentions, quote: !!msg }, {
        lastCheck: () => this.d.db.updateMaySend(o.id),
        step: (what, detail = {}) => (o.job_id ? this.d.db.step(o.job_id, what, detail).catch(() => undefined) : undefined),
      });
      return this.d.db.updateDone(o.id, r.sent, r.sent ? null : 'not sent', r);
    } catch (e) {
      const final = e instanceof MaybeSentError;
      return this.d.db.updateDone(o.id, false, errMsg(e), { may_have_posted: final }, final);
    }
  }
}
