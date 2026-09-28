// In-memory RizehubDb for tests, mirroring supabase/migrations/20260928050000_rizehub.sql closely enough to exercise
// the tools, webhook route and background loop. FakeHqDb delegates its RizeHub methods here.
import { randomUUID } from 'node:crypto';
import type { FakeHqDb } from '../fakeHqDb';
import type {
  ActionApprovalRow, JobListQuery, JobOppStatus, JobOpportunityInput, JobOpportunityRow, RizehubDb, RizehubRefInput, RizehubRefRow,
  WebhookEventInput,
} from './store';

interface FakeEvent { id: string; event_id: string | null; event: string; payload: Record<string, unknown>; signature_ok: boolean; processed_at: string | null; result: Record<string, unknown> | null; attempts: number }

const now = () => new Date().toISOString();
const clean = (v: unknown, max = 80) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f`<>]+/g, ' ').trim().slice(0, max) || null : null);

export class FakeRizehubStore implements RizehubDb {
  refs: RizehubRefRow[] = [];
  events: FakeEvent[] = [];
  jobs: JobOpportunityRow[] = [];
  /** Approval status per id (FakeHqDb approvals have no status); default pending. */
  approvalStatus = new Map<string, ActionApprovalRow['status']>();
  constructor(private readonly host: FakeHqDb) {}

  /** Test helper: CEO decision on an external action (mirrors decide_approval for external_action). */
  decide(approvalId: string, decision: 'approved' | 'rejected') {
    this.approvalStatus.set(approvalId, decision);
    const ap = this.host.approvals.find((a) => a.id === approvalId);
    const t = ap?.task_id ? this.host.tasks.get(ap.task_id) : undefined;
    if (t && (t.status === 'awaiting_ceo' || t.status === 'failed')) {
      t.status = 'queued';
      t.qa_feedback = { ...(t.qa_feedback ?? {}), ceo_decision: decision === 'approved' ? 'approve' : 'reject', ceo_note: null };
    }
  }

  async recordRizehubRef(r: RizehubRefInput) {
    const clientId = r.clientId ?? (r.taskId ? this.host.tasks.get(r.taskId)?.client_id ?? null : null);
    let row = this.refs.find((x) => x.kind === r.kind && x.rizehub_id === r.rizehubId);
    if (row) {
      row.summary = { ...row.summary, ...r.summary };
      row.task_id = r.taskId ?? row.task_id;
      row.client_id = clientId ?? row.client_id;
      row.updated_at = now();
    } else {
      row = { id: randomUUID(), task_id: r.taskId, client_id: clientId, kind: r.kind, rizehub_id: r.rizehubId, summary: { ...r.summary }, created_at: now(), updated_at: now() };
      this.refs.push(row);
    }
    return row.id;
  }
  async listRizehubRefs(q: { kind?: RizehubRefRow['kind']; ids?: string[]; taskId?: string; pendingJobs?: boolean; limit?: number }) {
    return this.refs.filter((r) => (!q.kind || r.kind === q.kind) && (!q.ids?.length || q.ids.includes(r.rizehub_id))
      && (!q.taskId || r.task_id === q.taskId) && (!q.pendingJobs || (r.kind === 'job' && r.summary.status === 'pending')))
      .slice(0, q.limit ?? 200);
  }
  async parkTaskForJob(taskId: string, jobId: string, summary: Record<string, unknown>) {
    const t = this.host.tasks.get(taskId);
    if (!t || t.status !== 'working') throw new Error(`task ${taskId} is not in progress`);
    t.status = 'pending';
    t.qa_feedback = { source: 'rizehub', fix_list: [`RizeHub job ${jobId} was still running`] };
    await this.recordRizehubRef({ taskId, kind: 'job', rizehubId: jobId, summary: { ...summary, status: 'pending', waiting_task_id: taskId } });
  }
  async rizehubJobFinished(jobId: string, status: 'completed' | 'failed', result: Record<string, unknown>) {
    const ref = this.refs.find((r) => r.kind === 'job' && r.rizehub_id === jobId);
    if (!ref) return 'unknown_job';
    if (ref.summary.status === 'completed' || ref.summary.status === 'failed') return 'already';
    ref.summary = { ...ref.summary, status, result, finished_at: now() };
    const tid = (ref.summary.waiting_task_id as string | undefined) ?? ref.task_id;
    const t = tid ? this.host.tasks.get(tid) : undefined;
    if (!t || t.status !== 'pending') return 'no_waiting_task';
    t.status = 'queued';
    t.qa_feedback = { source: 'rizehub', fix_list: [`RizeHub job ${jobId} ${status}. Call ${String(ref.summary.tool ?? 'the tool')} with action "job".`] };
    return 'resumed';
  }
  async requestRizehubAction(taskId: string, actionType: string, spec: Record<string, unknown>, pause: boolean) {
    const id = await this.host.requestExternalAction(taskId, actionType, spec);
    const t = this.host.tasks.get(taskId);
    if (pause && t?.status === 'working') t.status = 'awaiting_ceo';
    return id;
  }
  private toRow(a: FakeHqDb['approvals'][number]): ActionApprovalRow {
    const status = this.approvalStatus.get(a.id) ?? 'pending';
    return { id: a.id, task_id: a.task_id, agent_id: a.agent_id, status, payload: a.payload, created_at: now(), decided_at: status === 'pending' ? null : now() };
  }
  async listTaskActions(taskId: string) {
    return this.host.approvals.filter((a) => a.task_id === taskId && a.kind === 'external_action').map((a) => this.toRow(a)).reverse();
  }
  async listApprovedRizehubActions(limit: number) {
    return this.host.approvals.map((a) => this.toRow(a))
      .filter((a) => a.status === 'approved' && String(a.payload.action_type ?? '').startsWith('rizehub.') && !('executed_at' in a.payload))
      .slice(0, limit);
  }
  async externalActionExec(approvalId: string, phase: 'claim' | 'done' | 'failed', result: Record<string, unknown> = {}) {
    const ap = this.host.approvals.find((a) => a.id === approvalId);
    if (!ap) throw new Error('external action not found');
    if (phase === 'claim') {
      if (this.approvalStatus.get(approvalId) !== 'approved' || 'executed_at' in ap.payload || 'executing_at' in ap.payload) return false;
      ap.payload = { ...ap.payload, executing_at: now() };
      return true;
    }
    const { executing_at: _e, ...rest } = ap.payload;
    ap.payload = phase === 'done' ? { ...rest, executed_at: now(), execution: result } : { ...rest, last_error: result, failed_at: now() };
    return true;
  }
  async storeWebhookEvent(e: WebhookEventInput) {
    const dup = e.eventId ? this.events.find((x) => x.event_id === e.eventId) : undefined;
    if (dup) return { id: dup.id, duplicate: true };
    const row: FakeEvent = { id: randomUUID(), event_id: e.eventId, event: e.event, payload: e.payload, signature_ok: e.signatureOk, processed_at: null, result: null, attempts: 0 };
    this.events.push(row);
    return { id: row.id, duplicate: false };
  }
  async listUnprocessedWebhookEvents(limit: number) {
    return this.events.filter((e) => !e.processed_at && e.attempts < 5).slice(0, limit).map((e) => ({ id: e.id, event: e.event, attempts: e.attempts }));
  }
  private openRequest(line1: string) {
    return [...this.host.requests.values()].find((r) => r.source === 'rizehub' && r.raw_text.split('\n')[0] === line1
      && !['done', 'rejected', 'cancelled', 'failed'].includes(r.status));
  }
  async processRizehubEvent(id: string) {
    const ev = this.events.find((e) => e.id === id);
    if (!ev) throw new Error('webhook event not found');
    if (ev.processed_at) return { ...(ev.result ?? {}), already: true };
    ev.attempts++;
    const d = (ev.payload.data ?? {}) as Record<string, unknown>;
    let res: Record<string, unknown>;
    const makeRequest = (line1: string, rest: string) => {
      const open = this.openRequest(line1);
      if (open) return { action: 'duplicate_request', request_id: open.id };
      const r = this.host.addRequest({ source: 'rizehub', raw_text: `${line1}\n\n${rest}`, priority: 'high' });
      return { action: 'request_created', request_id: r.id };
    };
    if (!ev.signature_ok) res = { action: 'rejected', reason: 'bad signature' };
    else if (ev.event === 'job.completed' || ev.event === 'job.failed') {
      res = { action: 'job', outcome: await this.rizehubJobFinished(String(d.job_id ?? ''), ev.event === 'job.completed' ? 'completed' : 'failed', (d.result ?? {}) as Record<string, unknown>) };
    } else if (ev.event === 'client.signed_up' || ev.event === 'payment.received') {
      const company = clean(d.company);
      const pkg = clean(d.package ?? d.plan, 60);
      res = company ? makeRequest(`Onboard ${company}${pkg ? ` on ${pkg}` : ''}`, `Created automatically from RizeHub (${ev.event}).`) : { action: 'ignored', reason: 'no company in payload' };
    } else if (ev.event === 'lead.replied') {
      if (d.lead_id) await this.recordRizehubRef({ taskId: null, kind: 'lead', rizehubId: String(d.lead_id), summary: { stage: 'replied', replied_at: now() } });
      const ref = this.refs.find((r) => r.kind === 'lead' && r.rizehub_id === d.lead_id);
      const company = clean(d.company) ?? clean(ref?.summary.company) ?? 'a lead';
      res = makeRequest(`Pipeline follow-up: ${company} replied to our outreach`, `RizeHub lead ${String(d.lead_id ?? '')}.`);
    } else if (ev.event === 'report.viewed') {
      const ref = this.refs.find((r) => r.kind === 'report' && r.rizehub_id === d.report_id);
      if (ref) ref.summary = { ...ref.summary, viewed_at: now(), views: Number(ref.summary.views ?? 0) + 1 };
      this.host.activity.push({ actor: 'rizehub', action: 'rizehub.report_viewed', task_id: ref?.task_id ?? null, detail: d, cost_usd: 0, created_at: now() });
      res = { action: 'logged' };
    } else if (ev.event === 'account.created' || ev.event === 'workspace.ready') {
      res = { action: 'logged' };
    } else res = { action: 'ignored', reason: 'unknown event' };
    ev.processed_at = now();
    ev.result = res;
    return res;
  }

  async upsertJobOpportunity(job: JobOpportunityInput, taskId: string | null) {
    if (!/^https?:\/\//i.test(job.url)) throw new Error('job url must be http(s)');
    if (!job.title?.trim()) throw new Error('job title is required');
    if (job.status === 'applied' || job.status === 'approved') throw new Error(`status ${job.status} is set by the CEO, not by agents`);
    const locked: JobOppStatus[] = ['applied', 'approved', 'replied', 'interview', 'offer', 'rejected'];
    const existing = this.jobs.find((j) => j.url === job.url);
    if (existing) {
      Object.assign(existing, {
        title: job.title, company: job.company ?? existing.company, rate: job.rate ?? existing.rate, posted_at: job.posted_at ?? existing.posted_at,
        fit_score: job.fit_score ?? existing.fit_score, draft: job.draft ?? existing.draft, notes: job.notes ?? existing.notes,
        platform_tags: job.platform_tags?.length ? job.platform_tags : existing.platform_tags,
        fit_reasons: job.fit_reasons?.length ? job.fit_reasons : existing.fit_reasons,
        red_flags: job.red_flags ?? existing.red_flags, task_id: taskId ?? existing.task_id,
        status: locked.includes(existing.status) || !job.status ? existing.status : job.status, updated_at: now(),
      });
      return { id: existing.id, created: false, status: existing.status };
    }
    const row: JobOpportunityRow = {
      id: randomUUID(), source: job.source ?? 'pasted', url: job.url, title: job.title, company: job.company ?? null,
      platform_tags: job.platform_tags ?? [], rate: job.rate ?? null, posted_at: job.posted_at ?? null, fit_score: job.fit_score ?? null,
      fit_reasons: job.fit_reasons ?? [], red_flags: job.red_flags ?? [], draft: job.draft ?? null, status: job.status ?? 'found',
      applied_at: null, follow_up_at: null, task_id: taskId, notes: job.notes ?? null, created_at: now(), updated_at: now(),
    };
    this.jobs.push(row);
    return { id: row.id, created: true, status: row.status };
  }
  async setJobStatus(id: string, status: JobOppStatus, followUpAt: string | null, note: string | null) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new Error(`job ${id} not found`);
    j.status = status;
    if (status === 'applied') j.applied_at ??= now();
    j.follow_up_at = followUpAt ?? (['replied', 'interview', 'offer', 'rejected', 'skipped'].includes(status) ? null : j.follow_up_at);
    if (note) j.notes = note;
    return { ...j };
  }
  async listJobOpportunities(q: JobListQuery) {
    const s = q.search?.toLowerCase();
    return this.jobs.filter((j) => (!q.status?.length || q.status.includes(j.status)) && (!q.urls?.length || q.urls.includes(j.url))
      && (!s || j.title.toLowerCase().includes(s) || (j.company ?? '').toLowerCase().includes(s))).slice(0, q.limit ?? 100);
  }
  async queueJobFollowUps() { return 0; }
}
