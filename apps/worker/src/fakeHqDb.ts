// In-memory HqDb for tests. Mirrors the RPC state transitions closely enough to exercise the
// worker logic; the real rules are tested against Postgres in scripts/db-test.mjs.
import { randomUUID } from 'node:crypto';
import { isQaPass, type AgentStatus, type Plan, type QaVerdict } from '@rizehubhq/shared';
import type {
  ActivityRow, AgentRow, ClientRow, HqDb, ReportInput, ReportKeyRow, RequestRow, ScreenRow, ScreenUpdate, TaskOutput, TaskRow, UsageRecord,
} from './hqdb';
import { emptyFacts, type DayFacts } from './reports';

export interface FakeApproval { id: string; kind: string; request_id: string | null; task_id: string | null; agent_id: string | null; title: string; payload: Record<string, unknown> }
export interface FakeCall { fn: string; args: unknown[] }

export class FakeHqDb implements HqDb {
  agents = new Map<string, AgentRow>();
  clients = new Map<string, ClientRow>();
  requests = new Map<string, RequestRow>();
  tasks = new Map<string, TaskRow>();
  approvals: FakeApproval[] = [];
  screens = new Map<string, ScreenRow>();
  activity: (ActivityRow & { request_id?: string | null })[] = [];
  messages: { agent_id: string; sender: 'ceo' | 'agent'; body: string; task_id: string | null }[] = [];
  usage: UsageRecord[] = [];
  calls: FakeCall[] = [];
  heartbeats = 0;
  reports: (ReportInput & { id: string })[] = [];
  settings: Record<string, unknown> = {};
  /** Facts returned by reportFacts(); tests set this per window start date. */
  facts = new Map<string, DayFacts>();

  constructor(agentIds: string[] = ['coo', 'seo-1', 'seo-2', 'qa-lead', 'uiux-1', 'graphic-1']) {
    for (const id of agentIds) this.addAgent(id);
  }

  addAgent(id: string, extra: Partial<AgentRow> = {}): AgentRow {
    const a: AgentRow = {
      id, name: id, department: 'x', model_role: 'specialist', model_override: null, status: 'idle',
      current_task_id: null, idle_activity: null, idle_since: new Date(Date.now() - 120_000).toISOString(), enabled: true, ...extra,
    };
    this.agents.set(id, a);
    return a;
  }
  addRequest(r: Partial<RequestRow> & { raw_text: string }): RequestRow {
    const row: RequestRow = { id: randomUUID(), source: 'dashboard', client_id: null, title: null, brief: null, priority: 'normal', due_date: null, status: 'staged', ...r };
    this.requests.set(row.id, row);
    return row;
  }
  addTask(t: Partial<TaskRow> & { agent_id: string }): TaskRow {
    const row: TaskRow = {
      id: randomUUID(), request_id: randomUUID(), client_id: null, title: 'Write article', instructions: 'Write it.',
      work_type: 'seo-article', acceptance_criteria: ['a', 'b', 'c'], status: 'queued', revision_count: 0, max_revisions: 3,
      qa_feedback: null, output: null, ...t,
    };
    this.tasks.set(row.id, row);
    return row;
  }

  private log(fn: string, ...args: unknown[]) { this.calls.push({ fn, args }); }
  callsOf(fn: string) { return this.calls.filter((c) => c.fn === fn); }
  private task(id: string) { const t = this.tasks.get(id); if (!t) throw new Error('task not found'); return t; }
  private refresh(agentId: string): AgentStatus | null {
    const a = this.agents.get(agentId); if (!a) return null;
    const tasks = [...this.tasks.values()].filter((t) => t.agent_id === agentId);
    a.status = tasks.some((t) => t.status === 'working' || t.status === 'qa_reviewing') ? 'working'
      : this.approvals.some((ap) => ap.agent_id === agentId) ? 'waiting' : 'idle';
    return a.status;
  }
  private approval(a: Omit<FakeApproval, 'id'>): string {
    const id = randomUUID(); this.approvals.push({ id, ...a }); return id;
  }

  async claimRequestForPlanning() {
    this.log('claimRequestForPlanning');
    const r = [...this.requests.values()].find((x) => x.status === 'staged');
    if (!r) return null;
    r.status = 'planning';
    return { ...r };
  }
  async submitPlan(requestId: string, plan: Plan) {
    this.log('submitPlan', requestId, plan);
    const r = this.requests.get(requestId);
    if (!r || r.status !== 'planning') throw new Error(`request ${requestId} is not being planned`);
    for (const t of plan.tasks) if (!this.agents.get(t.agent_id)?.enabled) throw new Error(`plan uses unknown or disabled agent ${t.agent_id}`);
    r.status = 'plan_review'; r.brief = plan as unknown as Record<string, unknown>; r.title = plan.title;
    return this.approval({ kind: 'plan', request_id: requestId, task_id: null, agent_id: 'coo', title: `Plan: ${plan.title}`, payload: plan as unknown as Record<string, unknown> });
  }
  async planningFailed(requestId: string, reason: string) {
    this.log('planningFailed', requestId, reason);
    const r = this.requests.get(requestId);
    if (!r || !['planning', 'staged'].includes(r.status)) throw new Error('not being planned');
    r.status = 'failed';
    return this.approval({ kind: 'external_action', request_id: requestId, task_id: null, agent_id: 'coo', title: `COO couldn't plan this: ${reason}`, payload: { type: 'planning_failed', reason } });
  }
  async releaseRequestForPlanning(requestId: string, reason: string) {
    this.log('releaseRequestForPlanning', requestId, reason);
    const r = this.requests.get(requestId); if (r?.status === 'planning') r.status = 'staged';
  }

  async claimNextTask() {
    this.log('claimNextTask');
    const t = [...this.tasks.values()].find((x) => x.status === 'queued' && this.agents.get(x.agent_id)?.enabled);
    if (!t) return null;
    t.status = 'working'; this.refresh(t.agent_id);
    return { ...t };
  }
  async reportProgress(taskId: string, percent: number, note: string, screen: ScreenUpdate = {}) {
    this.log('reportProgress', taskId, percent, note, screen);
    const t = this.task(taskId);
    this.screens.set(t.agent_id, { agent_id: t.agent_id, task_id: taskId, app: screen.app ?? 'editor', title: screen.title ?? null,
      content: screen.content ?? null, step_note: note, progress: percent, updated_at: new Date().toISOString() });
  }
  async touchHeartbeat(taskId: string) { this.heartbeats++; this.log('touchHeartbeat', taskId); }
  async submitTaskOutput(taskId: string, output: TaskOutput) {
    this.log('submitTaskOutput', taskId, output);
    const t = this.task(taskId);
    if (t.status !== 'working') throw new Error(`task ${taskId} is not in progress`);
    t.output = output as unknown as Record<string, unknown>; t.status = 'qa_pending'; this.refresh(t.agent_id);
  }
  async askCeo(taskId: string, question: string, options: string[]) {
    this.log('askCeo', taskId, question, options);
    const t = this.task(taskId);
    if (t.status !== 'working') throw new Error(`task ${taskId} is not in progress`);
    t.status = 'awaiting_ceo';
    return this.approval({ kind: 'external_action', request_id: t.request_id, task_id: taskId, agent_id: t.agent_id, title: `Question: ${question}`, payload: { type: 'question', question, options } });
  }
  async requestExternalAction(taskId: string, type: string, spec: Record<string, unknown>) {
    this.log('requestExternalAction', taskId, type, spec);
    const t = this.task(taskId);
    return this.approval({ kind: 'external_action', request_id: t.request_id, task_id: taskId, agent_id: t.agent_id, title: `Action: ${type}`, payload: { type: 'external_action', action_type: type, spec } });
  }
  async failTask(taskId: string, reason: string) {
    this.log('failTask', taskId, reason);
    const t = this.task(taskId);
    if (['done', 'cancelled'].includes(t.status)) return;
    t.status = 'failed';
  }
  async requeueTask(taskId: string, reason: string) {
    this.log('requeueTask', taskId, reason);
    const t = this.task(taskId); if (t.status === 'working') t.status = 'queued';
  }
  async requeueStaleTasks() { this.log('requeueStaleTasks'); return 0; }
  async finishAgentTurn(agentId: string) { this.log('finishAgentTurn', agentId); return this.refresh(agentId); }

  async claimQaReview() {
    this.log('claimQaReview');
    const t = [...this.tasks.values()].find((x) => x.status === 'qa_pending');
    if (!t) return null;
    t.status = 'qa_reviewing';
    return { ...t };
  }
  async recordQaVerdict(taskId: string, reviewer: string, verdict: QaVerdict, threshold: number) {
    this.log('recordQaVerdict', taskId, reviewer, verdict, threshold);
    const t = this.task(taskId);
    if (t.status !== 'qa_reviewing') throw new Error(`task ${taskId} is not under QA`);
    if (isQaPass(verdict, threshold)) { t.status = 'awaiting_ceo'; t.qa_feedback = null; return 'pass'; }
    t.revision_count++;
    t.qa_feedback = { source: 'qa', fix_list: verdict.fix_list, failed_checks: verdict.checks.filter((c) => c.result !== 'pass') };
    if (t.revision_count > t.max_revisions) { t.status = 'failed'; return 'escalated'; }
    t.status = 'queued';
    return 'revision';
  }
  async releaseQaReview(taskId: string, reason: string) {
    this.log('releaseQaReview', taskId, reason);
    const t = this.task(taskId); if (t.status === 'qa_reviewing') t.status = 'qa_pending';
  }

  async setIdleActivity(agentId: string, activity: string | null) {
    this.log('setIdleActivity', agentId, activity);
    const a = this.agents.get(agentId);
    if (!a || a.status !== 'idle') return false;
    a.idle_activity = activity; return true;
  }
  async updateAgentScreen(agentId: string, taskId: string | null, screen: ScreenUpdate & { step_note?: string; progress?: number }) {
    this.log('updateAgentScreen', agentId, taskId, screen);
    this.screens.set(agentId, { agent_id: agentId, task_id: taskId, app: screen.app ?? 'doc', title: screen.title ?? null,
      content: screen.content ?? null, step_note: screen.step_note ?? null, progress: screen.progress ?? null, updated_at: new Date().toISOString() });
  }
  async recordUsage(u: UsageRecord) {
    this.usage.push(u);
    this.activity.push({ actor: u.actor, action: `usage.${u.kind}`, task_id: u.taskId ?? null, request_id: u.requestId ?? null,
      detail: { ...u.detail, tokens_in: u.tokensIn, tokens_out: u.tokensOut }, cost_usd: u.costUsd, created_at: new Date().toISOString() });
  }
  async addAgentMessage(agentId: string, sender: 'ceo' | 'agent', body: string, taskId: string | null = null) {
    this.messages.push({ agent_id: agentId, sender, body, task_id: taskId });
  }

  async listAgents() { return [...this.agents.values()].map((a) => ({ ...a })); }
  async getAgent(id: string) { const a = this.agents.get(id); return a ? { ...a } : null; }
  async getClient(id: string) { return this.clients.get(id) ?? null; }
  async getRequest(id: string) { return this.requests.get(id) ?? null; }
  async getTask(id: string) { const t = this.tasks.get(id); return t ? { ...t } : null; }
  async getAgentScreen(agentId: string) { return this.screens.get(agentId) ?? null; }
  async recentActivity(agentId: string, limit: number) {
    return this.activity.filter((a) => a.actor === agentId).slice(-limit).reverse();
  }
  async monthSpendUsd() { return this.usage.reduce((s, u) => s + u.costUsd, 0); }

  async reportFacts(from: string, days: number) {
    this.log('reportFacts', from, days);
    return this.facts.get(`${from}:${days}`) ?? this.facts.get(from) ?? emptyFacts(from);
  }
  async saveReport(r: ReportInput, overwrite = false) {
    this.log('saveReport', r, overwrite);
    const i = this.reports.findIndex((x) => (x.agentId ?? '') === (r.agentId ?? '') && x.date === r.date && x.kind === r.kind);
    if (i >= 0) {
      if (!overwrite) return null;
      this.reports[i] = { ...r, id: this.reports[i]!.id };
      return this.reports[i]!.id;
    }
    const id = randomUUID();
    this.reports.push({ ...r, id });
    return id;
  }
  async existingReports(sinceDate: string): Promise<ReportKeyRow[]> {
    return this.reports.filter((r) => r.date >= sinceDate).map((r) => ({ kind: r.kind, report_date: r.date, agent_id: r.agentId }));
  }
  async getSettings() { this.log('getSettings'); return { ...this.settings }; }

  // ---------- RizeHub integration (M9b/M9c): delegated to ./rizehub/fakeStore.ts ----------
  readonly rizehub = new FakeRizehubStore(this);
  recordRizehubRef(...a: Parameters<RizehubDb['recordRizehubRef']>) { this.log('recordRizehubRef', ...a); return this.rizehub.recordRizehubRef(...a); }
  listRizehubRefs(...a: Parameters<RizehubDb['listRizehubRefs']>) { return this.rizehub.listRizehubRefs(...a); }
  parkTaskForJob(...a: Parameters<RizehubDb['parkTaskForJob']>) { this.log('parkTaskForJob', ...a); return this.rizehub.parkTaskForJob(...a); }
  rizehubJobFinished(...a: Parameters<RizehubDb['rizehubJobFinished']>) { this.log('rizehubJobFinished', ...a); return this.rizehub.rizehubJobFinished(...a); }
  requestRizehubAction(...a: Parameters<RizehubDb['requestRizehubAction']>) { this.log('requestRizehubAction', ...a); return this.rizehub.requestRizehubAction(...a); }
  listTaskActions(...a: Parameters<RizehubDb['listTaskActions']>) { return this.rizehub.listTaskActions(...a); }
  listApprovedRizehubActions(...a: Parameters<RizehubDb['listApprovedRizehubActions']>) { return this.rizehub.listApprovedRizehubActions(...a); }
  externalActionExec(...a: Parameters<RizehubDb['externalActionExec']>) { this.log('externalActionExec', ...a); return this.rizehub.externalActionExec(...a); }
  storeWebhookEvent(...a: Parameters<RizehubDb['storeWebhookEvent']>) { this.log('storeWebhookEvent', ...a); return this.rizehub.storeWebhookEvent(...a); }
  listUnprocessedWebhookEvents(...a: Parameters<RizehubDb['listUnprocessedWebhookEvents']>) { return this.rizehub.listUnprocessedWebhookEvents(...a); }
  processRizehubEvent(...a: Parameters<RizehubDb['processRizehubEvent']>) { this.log('processRizehubEvent', ...a); return this.rizehub.processRizehubEvent(...a); }
  upsertJobOpportunity(...a: Parameters<RizehubDb['upsertJobOpportunity']>) { this.log('upsertJobOpportunity', ...a); return this.rizehub.upsertJobOpportunity(...a); }
  setJobStatus(...a: Parameters<RizehubDb['setJobStatus']>) { this.log('setJobStatus', ...a); return this.rizehub.setJobStatus(...a); }
  listJobOpportunities(...a: Parameters<RizehubDb['listJobOpportunities']>) { return this.rizehub.listJobOpportunities(...a); }
  queueJobFollowUps() { return this.rizehub.queueJobFollowUps(); }
}

import { FakeRizehubStore } from './rizehub/fakeStore';
import type { RizehubDb } from './rizehub/store';
