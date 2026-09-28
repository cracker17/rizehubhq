// HqDb methods for the RizeHub integration (merged into HqDb in hqdb.ts). Every write goes through the RPCs in
// supabase/migrations/20260928050000_rizehub.sql; reads are small selects.
import type { SupabaseClient } from '@supabase/supabase-js';

export type RizehubRefKind = 'lead' | 'lead_list' | 'account' | 'workspace' | 'report' | 'job' | 'invite';
export interface RizehubRefInput { taskId: string | null; kind: RizehubRefKind; rizehubId: string; summary: Record<string, unknown>; clientId?: string | null }
export interface RizehubRefRow {
  id: string; task_id: string | null; client_id: string | null; kind: RizehubRefKind; rizehub_id: string;
  summary: Record<string, unknown>; created_at: string; updated_at: string;
}
export interface ActionApprovalRow {
  id: string; task_id: string | null; agent_id: string | null; status: 'pending' | 'approved' | 'rejected' | 'changes_requested';
  payload: Record<string, unknown>; created_at: string; decided_at: string | null;
}
export interface WebhookEventInput { eventId: string | null; event: string; payload: Record<string, unknown>; signatureOk: boolean }
export const JOB_STATUSES = ['found', 'shortlisted', 'drafted', 'approved', 'applied', 'replied', 'interview', 'offer', 'rejected', 'skipped'] as const;
export type JobOppStatus = (typeof JOB_STATUSES)[number];
export interface JobOpportunityInput {
  url: string; title: string; source?: string; company?: string | null; platform_tags?: string[]; rate?: string | null;
  posted_at?: string | null; fit_score?: number | null; fit_reasons?: string[]; red_flags?: string[]; draft?: string | null;
  status?: JobOppStatus; notes?: string | null;
}
export interface JobOpportunityRow {
  id: string; source: string; url: string; title: string; company: string | null; platform_tags: string[]; rate: string | null;
  posted_at: string | null; fit_score: number | null; fit_reasons: string[]; red_flags: string[]; draft: string | null;
  status: JobOppStatus; applied_at: string | null; follow_up_at: string | null; task_id: string | null; notes: string | null;
  created_at: string; updated_at?: string;
}
export interface JobListQuery { status?: JobOppStatus[]; urls?: string[]; search?: string; limit?: number }

export interface RizehubDb {
  recordRizehubRef(r: RizehubRefInput): Promise<string>;
  listRizehubRefs(q: { kind?: RizehubRefKind; ids?: string[]; taskId?: string; pendingJobs?: boolean; limit?: number }): Promise<RizehubRefRow[]>;
  parkTaskForJob(taskId: string, jobId: string, summary: Record<string, unknown>): Promise<void>;
  rizehubJobFinished(jobId: string, status: 'completed' | 'failed', result: Record<string, unknown>): Promise<string>;
  requestRizehubAction(taskId: string, actionType: string, spec: Record<string, unknown>, pause: boolean): Promise<string>;
  listTaskActions(taskId: string): Promise<ActionApprovalRow[]>;
  listApprovedRizehubActions(limit: number): Promise<ActionApprovalRow[]>;
  externalActionExec(approvalId: string, phase: 'claim' | 'done' | 'failed', result?: Record<string, unknown>): Promise<boolean>;
  storeWebhookEvent(e: WebhookEventInput): Promise<{ id: string; duplicate: boolean }>;
  listUnprocessedWebhookEvents(limit: number): Promise<{ id: string; event: string; attempts: number }[]>;
  processRizehubEvent(id: string): Promise<Record<string, unknown>>;
  upsertJobOpportunity(job: JobOpportunityInput, taskId: string | null): Promise<{ id: string; created: boolean; status: string }>;
  setJobStatus(id: string, status: JobOppStatus, followUpAt: string | null, note: string | null): Promise<JobOpportunityRow>;
  listJobOpportunities(q: JobListQuery): Promise<JobOpportunityRow[]>;
  queueJobFollowUps(): Promise<number>;
}

const JOB_COLS = 'id,source,url,title,company,platform_tags,rate,posted_at,fit_score,fit_reasons,red_flags,draft,status,applied_at,follow_up_at,task_id,notes,created_at,updated_at';

export function rizehubSupabaseDb(sb: SupabaseClient): RizehubDb {
  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  }
  async function rows<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
    const { data, error } = await q;
    if (error) throw new Error(`${what}: ${error.message}`);
    return (data ?? []) as T[];
  }
  return {
    recordRizehubRef: (r) => rpc<string>('record_rizehub_ref', {
      p_task: r.taskId, p_kind: r.kind, p_rizehub_id: r.rizehubId, p_summary: r.summary, p_client: r.clientId ?? null,
    }),
    listRizehubRefs: async (q) => {
      let query = sb.from('rizehub_refs').select('id,task_id,client_id,kind,rizehub_id,summary,created_at,updated_at');
      if (q.kind) query = query.eq('kind', q.kind);
      if (q.ids?.length) query = query.in('rizehub_id', q.ids);
      if (q.taskId) query = query.eq('task_id', q.taskId);
      if (q.pendingJobs) query = query.eq('kind', 'job').eq('summary->>status', 'pending');
      return rows<RizehubRefRow>(query.order('updated_at', { ascending: false }).limit(q.limit ?? 200), 'rizehub_refs');
    },
    parkTaskForJob: async (taskId, jobId, summary) => { await rpc('park_task_for_job', { p_task: taskId, p_job_id: jobId, p_summary: summary }); },
    rizehubJobFinished: (jobId, status, result) => rpc<string>('rizehub_job_finished', { p_job_id: jobId, p_status: status, p_result: result }),
    requestRizehubAction: (taskId, actionType, spec, pause) =>
      rpc<string>('request_rizehub_action', { p_task: taskId, p_action_type: actionType, p_spec: spec, p_pause: pause }),
    listTaskActions: (taskId) => rows<ActionApprovalRow>(sb.from('approvals')
      .select('id,task_id,agent_id,status,payload,created_at,decided_at').eq('task_id', taskId).eq('kind', 'external_action')
      .order('created_at', { ascending: false }).limit(100), 'approvals'),
    listApprovedRizehubActions: async (limit) => {
      const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
      const list = await rows<ActionApprovalRow>(sb.from('approvals')
        .select('id,task_id,agent_id,status,payload,created_at,decided_at').eq('kind', 'external_action').eq('status', 'approved')
        .like('payload->>action_type', 'rizehub.%').gte('decided_at', since).order('decided_at').limit(limit * 4), 'approvals');
      return list.filter((a) => !('executed_at' in a.payload)).slice(0, limit);
    },
    externalActionExec: async (approvalId, phase, result = {}) =>
      Boolean(await rpc('external_action_exec', { p_approval: approvalId, p_phase: phase, p_result: result })),
    storeWebhookEvent: (e) => rpc<{ id: string; duplicate: boolean }>('store_webhook_event', {
      p_event_id: e.eventId, p_event: e.event, p_payload: e.payload, p_signature_ok: e.signatureOk,
    }),
    listUnprocessedWebhookEvents: (limit) => rows<{ id: string; event: string; attempts: number }>(sb.from('webhook_events')
      .select('id,event,attempts').is('processed_at', null).lt('attempts', 5).order('created_at').limit(limit), 'webhook_events'),
    processRizehubEvent: (id) => rpc<Record<string, unknown>>('process_rizehub_event', { p_id: id }),
    upsertJobOpportunity: (job, taskId) => rpc<{ id: string; created: boolean; status: string }>('upsert_job_opportunity', { p_job: job, p_task: taskId }),
    setJobStatus: (id, status, followUpAt, note) => rpc<JobOpportunityRow>('set_job_status', {
      p_id: id, p_status: status, p_follow_up_at: followUpAt, p_note: note,
    }),
    listJobOpportunities: (q) => {
      let query = sb.from('job_opportunities').select(JOB_COLS);
      if (q.status?.length) query = query.in('status', q.status);
      if (q.urls?.length) query = query.in('url', q.urls);
      if (q.search) query = query.or(`title.ilike.%${q.search.replace(/[%,()]/g, ' ')}%,company.ilike.%${q.search.replace(/[%,()]/g, ' ')}%`);
      return rows<JobOpportunityRow>(query.order('created_at', { ascending: false }).limit(q.limit ?? 100), 'job_opportunities');
    },
    queueJobFollowUps: async () => Number(await rpc<number>('queue_job_follow_ups', {}) ?? 0),
  };
}
