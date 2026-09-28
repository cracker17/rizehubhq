// HqDb: the worker's only door to Supabase. Every state change goes through the workflow RPCs
// (supabase/migrations/*workflow_engine.sql + *worker_helpers.sql); reads are small selects.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentStatus, Plan, QaVerdict, RequestStatus, TaskStatus } from '@rizehubhq/shared';
import type { DayFacts } from './reports';

export interface RequestRow {
  id: string;
  source: string;
  raw_text: string;
  client_id: string | null;
  title: string | null;
  brief: Record<string, unknown> | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  due_date: string | null;
  status: RequestStatus;
  created_at?: string;
}

export interface TaskRow {
  id: string;
  request_id: string;
  client_id: string | null;
  agent_id: string;
  title: string;
  instructions: string;
  work_type: string;
  acceptance_criteria: string[];
  status: TaskStatus;
  revision_count: number;
  max_revisions: number;
  qa_feedback: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  cost_usd?: number | string;
}

export interface AgentRow {
  id: string;
  name: string;
  department: string;
  model_role: string;
  model_override: string | null;
  status: AgentStatus;
  current_task_id: string | null;
  idle_activity: string | null;
  idle_since: string | null;
  enabled: boolean;
}

export interface ClientRow {
  id: string;
  name: string;
  slug: string;
  platforms: string[];
  website: string | null;
  service_package: string | null;
  status: string;
  notes: string | null;
}

export interface ScreenRow {
  agent_id: string;
  task_id: string | null;
  app: string;
  title: string | null;
  content: string | null;
  step_note: string | null;
  progress: number | null;
  updated_at: string;
}

export interface ActivityRow {
  actor: string;
  action: string;
  task_id: string | null;
  detail: Record<string, unknown>;
  cost_usd: number | string;
  created_at: string;
}

export interface ScreenUpdate { app?: string; title?: string; content?: string; image_url?: string }

/** Deliverable written by submit_output (tasks.output). */
export interface TaskOutput {
  summary: string;
  content?: string;
  files: string[];
  links: string[];
  preview_url?: string | null;
  criteria_map: Record<string, string>;
  fallback?: boolean;
}

export interface UsageRecord {
  actor: string;
  kind: 'task' | 'plan' | 'qa' | 'chat' | 'report';
  taskId?: string | null;
  requestId?: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  detail: Record<string, unknown>;
}

/** One row for save_report() (supabase/migrations/20260928030000_reports_telegram.sql). */
export interface ReportInput {
  agentId: string | null;
  date: string;
  kind: 'standup' | 'daily_digest' | 'morning_brief' | 'weekly';
  done?: string[];
  next?: string[];
  blockers?: string[];
  bodyMd: string;
  costUsd: number;
  data?: Record<string, unknown>;
}
export interface ReportKeyRow { kind: string; report_date: string; agent_id: string | null }

export interface HqDb {
  // planning
  claimRequestForPlanning(): Promise<RequestRow | null>;
  submitPlan(requestId: string, plan: Plan): Promise<string>;
  planningFailed(requestId: string, reason: string): Promise<string>;
  releaseRequestForPlanning(requestId: string, reason: string): Promise<void>;
  // tasks
  claimNextTask(): Promise<TaskRow | null>;
  reportProgress(taskId: string, percent: number, note: string, screen?: ScreenUpdate): Promise<void>;
  touchHeartbeat(taskId: string): Promise<void>;
  submitTaskOutput(taskId: string, output: TaskOutput): Promise<void>;
  askCeo(taskId: string, question: string, options: string[]): Promise<string>;
  requestExternalAction(taskId: string, type: string, spec: Record<string, unknown>): Promise<string>;
  failTask(taskId: string, reason: string): Promise<void>;
  requeueTask(taskId: string, reason: string): Promise<void>;
  requeueStaleTasks(): Promise<number>;
  finishAgentTurn(agentId: string): Promise<AgentStatus | null>;
  // QA
  claimQaReview(): Promise<TaskRow | null>;
  recordQaVerdict(taskId: string, reviewer: string, verdict: QaVerdict, threshold: number): Promise<string>;
  releaseQaReview(taskId: string, reason: string): Promise<void>;
  // office
  setIdleActivity(agentId: string, activity: string | null): Promise<boolean>;
  updateAgentScreen(agentId: string, taskId: string | null, screen: ScreenUpdate & { step_note?: string; progress?: number }): Promise<void>;
  recordUsage(u: UsageRecord): Promise<void>;
  addAgentMessage(agentId: string, sender: 'ceo' | 'agent', body: string, taskId?: string | null): Promise<void>;
  // reads
  listAgents(): Promise<AgentRow[]>;
  getAgent(id: string): Promise<AgentRow | null>;
  getClient(id: string): Promise<ClientRow | null>;
  getRequest(id: string): Promise<RequestRow | null>;
  getTask(id: string): Promise<TaskRow | null>;
  getAgentScreen(agentId: string): Promise<ScreenRow | null>;
  recentActivity(agentId: string, limit: number): Promise<ActivityRow[]>;
  monthSpendUsd(): Promise<number>;
  // reports + settings (M7)
  reportFacts(from: string, days: number): Promise<DayFacts>;
  /** Returns the new id, or null when that (author, date, kind) already exists and overwrite is false. */
  saveReport(r: ReportInput, overwrite?: boolean): Promise<string | null>;
  existingReports(sinceDate: string): Promise<ReportKeyRow[]>;
  getSettings(): Promise<Record<string, unknown>>;
}

/** A composite-returning RPC gives back a row of nulls (or null) when nothing was claimed. */
function rowOrNull<T extends { id: string }>(data: unknown): T | null {
  const row = (Array.isArray(data) ? data[0] : data) as T | null | undefined;
  return row && row.id ? row : null;
}

function normTask(t: TaskRow | null): TaskRow | null {
  if (!t) return null;
  return { ...t, acceptance_criteria: Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria : [] };
}

export function createSupabaseHqDb(sb: SupabaseClient): HqDb {
  async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  }
  async function maybeOne<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T | null> {
    const { data, error } = await q;
    if (error) throw new Error(`${what}: ${error.message}`);
    return (data as T | null) ?? null;
  }

  return {
    claimRequestForPlanning: async () => rowOrNull<RequestRow>(await rpc('claim_request_for_planning')),
    submitPlan: (requestId, plan) => rpc<string>('submit_plan', { p_request: requestId, p_plan: plan }),
    planningFailed: (requestId, reason) => rpc<string>('planning_failed', { p_request: requestId, p_reason: reason }),
    releaseRequestForPlanning: async (requestId, reason) => { await rpc('release_request_for_planning', { p_request: requestId, p_reason: reason }); },

    claimNextTask: async () => normTask(rowOrNull<TaskRow>(await rpc('claim_next_task'))),
    reportProgress: async (taskId, percent, note, screen = {}) => {
      await rpc('report_progress', { p_task: taskId, p_percent: Math.round(percent), p_note: note, p_screen: screen });
    },
    touchHeartbeat: async (taskId) => { await rpc('touch_task_heartbeat', { p_task: taskId }); },
    submitTaskOutput: async (taskId, output) => { await rpc('submit_task_output', { p_task: taskId, p_output: output }); },
    askCeo: (taskId, question, options) => rpc<string>('ask_ceo', { p_task: taskId, p_question: question, p_options: options }),
    requestExternalAction: (taskId, type, spec) => rpc<string>('request_external_action', { p_task: taskId, p_type: type, p_spec: spec }),
    failTask: async (taskId, reason) => { await rpc('fail_task', { p_task: taskId, p_reason: reason }); },
    requeueTask: async (taskId, reason) => { await rpc('requeue_task', { p_task: taskId, p_reason: reason }); },
    requeueStaleTasks: async () => Number((await rpc<number>('requeue_stale_tasks')) ?? 0),
    finishAgentTurn: (agentId) => rpc<AgentStatus | null>('finish_agent_turn', { p_agent: agentId }),

    claimQaReview: async () => normTask(rowOrNull<TaskRow>(await rpc('claim_qa_review'))),
    recordQaVerdict: (taskId, reviewer, verdict, threshold) =>
      rpc<string>('record_qa_verdict', { p_task: taskId, p_reviewer: reviewer, p_verdict: verdict, p_threshold: threshold }),
    releaseQaReview: async (taskId, reason) => { await rpc('release_qa_review', { p_task: taskId, p_reason: reason }); },

    setIdleActivity: async (agentId, activity) => Boolean(await rpc('set_idle_activity', { p_agent: agentId, p_activity: activity })),
    updateAgentScreen: async (agentId, taskId, screen) => { await rpc('update_agent_screen', { p_agent: agentId, p_task: taskId, p_screen: screen }); },
    recordUsage: async (u) => {
      await rpc('record_usage', {
        p_actor: u.actor, p_task: u.taskId ?? null, p_request: u.requestId ?? null, p_kind: u.kind,
        p_tokens_in: u.tokensIn, p_tokens_out: u.tokensOut, p_cost: u.costUsd, p_detail: u.detail,
      });
    },
    addAgentMessage: async (agentId, sender, body, taskId = null) => {
      const { error } = await sb.from('agent_messages').insert({ agent_id: agentId, sender, body, task_id: taskId });
      if (error) throw new Error(`agent_messages insert: ${error.message}`);
    },

    listAgents: async () => {
      const { data, error } = await sb.from('agents')
        .select('id,name,department,model_role,model_override,status,current_task_id,idle_activity,idle_since,enabled').order('id');
      if (error) throw new Error(`agents: ${error.message}`);
      return (data ?? []) as AgentRow[];
    },
    getAgent: (id) => maybeOne<AgentRow>(sb.from('agents')
      .select('id,name,department,model_role,model_override,status,current_task_id,idle_activity,idle_since,enabled').eq('id', id).maybeSingle(), 'agent'),
    getClient: (id) => maybeOne<ClientRow>(sb.from('clients')
      .select('id,name,slug,platforms,website,service_package,status,notes').eq('id', id).maybeSingle(), 'client'),
    getRequest: (id) => maybeOne<RequestRow>(sb.from('requests').select('*').eq('id', id).maybeSingle(), 'request'),
    getTask: async (id) => normTask(await maybeOne<TaskRow>(sb.from('tasks').select('*').eq('id', id).maybeSingle(), 'task')),
    getAgentScreen: (agentId) => maybeOne<ScreenRow>(sb.from('agent_screens').select('*').eq('agent_id', agentId).maybeSingle(), 'agent_screen'),
    recentActivity: async (agentId, limit) => {
      const { data, error } = await sb.from('activity_log').select('actor,action,task_id,detail,cost_usd,created_at')
        .eq('actor', agentId).order('created_at', { ascending: false }).limit(limit);
      if (error) throw new Error(`activity_log: ${error.message}`);
      return (data ?? []) as ActivityRow[];
    },
    monthSpendUsd: async () => {
      const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
      const { data, error } = await sb.from('activity_log').select('cost_usd').like('action', 'usage.%').gte('created_at', start.toISOString());
      if (error) throw new Error(`activity_log: ${error.message}`);
      return (data ?? []).reduce((s, r: { cost_usd: number | string }) => s + Number(r.cost_usd ?? 0), 0);
    },

    reportFacts: (from, days) => rpc<DayFacts>('report_facts', { p_from: from, p_days: days }),
    saveReport: async (r, overwrite = false) => (await rpc<string | null>('save_report', {
      p_agent: r.agentId, p_date: r.date, p_kind: r.kind, p_done: r.done ?? [], p_next: r.next ?? [], p_blockers: r.blockers ?? [],
      p_body: r.bodyMd, p_cost: r.costUsd, p_data: r.data ?? {}, p_overwrite: overwrite,
    })) ?? null,
    existingReports: async (sinceDate) => {
      const { data, error } = await sb.from('reports').select('kind,report_date,agent_id').gte('report_date', sinceDate);
      if (error) throw new Error(`reports: ${error.message}`);
      return (data ?? []) as ReportKeyRow[];
    },
    getSettings: async () => {
      const { data, error } = await sb.from('settings').select('key,value');
      if (error) throw new Error(`settings: ${error.message}`);
      return Object.fromEntries((data ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
    },
  };
}
