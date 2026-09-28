// Hand-written row types matching supabase/migrations/20260928000000_init_schema.sql.
// Keep in sync with the migrations (CLAUDE.md rule 3). Numeric columns may arrive as strings
// over Realtime, so treat `numeric` as `number | string` and convert with Number() when shown.
import type {
  AgentStatus, ApprovalKind, ApprovalStatus, IdleActivity, RequestStatus, TaskStatus,
} from '@rizehubhq/shared';

type Numeric = number | string;
export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface ClientRow {
  id: string;
  name: string;
  slug: string;
}

export interface AgentRow {
  id: string;
  name: string;
  department: string;
  model_role: string;
  status: AgentStatus;
  current_task_id: string | null;
  idle_activity: IdleActivity | null;
  idle_since: string | null;
  avatar: { color?: string; accessory?: string; sprite_set?: string } | null;
  /** Desk seat in the office layout (apps/dashboard/office/layout.json), e.g. { id: 'dev-1' }. */
  desk?: { id?: string } | null;
  enabled: boolean;
  updated_at: string;
}

export interface RequestRow {
  id: string;
  source: 'telegram' | 'dashboard' | 'schedule' | 'rizehub';
  raw_text: string;
  client_id: string | null;
  title: string | null;
  brief: Record<string, unknown> | null;
  priority: Priority;
  due_date: string | null;
  status: RequestStatus;
  cost_usd: Numeric;
  created_at: string;
  updated_at: string;
}

export interface TaskOutput {
  summary?: string;
  files?: (string | { name?: string; path?: string; url?: string })[];
  links?: (string | { label?: string; url: string })[];
  branch?: string;
  preview_url?: string;
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
  depends_on: string[];
  status: TaskStatus;
  revision_count: number;
  max_revisions: number;
  output: TaskOutput | null;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cost_usd: Numeric;
  created_at: string;
  updated_at: string;
}

export interface QaCheckJson { criterion: string; result: 'pass' | 'fail'; note?: string; evidence?: string }
export interface QaVerdictJson { verdict: 'pass' | 'fail'; score: number; checks: QaCheckJson[]; summary?: string; fix_list?: string[] }

/** Minimal slice of qa_reviews used for the 7-day pass rate. */
export interface QaReviewRow {
  id: string;
  task_id: string;
  verdict: 'pass' | 'fail';
  score: number | null;
  created_at: string;
}

export interface PlanTaskJson {
  key: string;
  agent_id: string;
  work_type: string;
  title: string;
  instructions?: string;
  acceptance_criteria: string[];
  depends_on?: string[];
}
/** approvals.payload for kind = 'plan' (packages/shared Plan schema). */
export interface PlanPayload {
  title: string;
  client_slug?: string | null;
  summary?: string;
  assumptions?: string[];
  questions_for_ceo?: string[];
  due_date?: string | null;
  priority?: Priority;
  estimated_cost_usd?: number;
  tasks: PlanTaskJson[];
}
/** approvals.payload for kind = 'deliverable' (record_qa_verdict). */
export interface DeliverablePayload { output?: TaskOutput | null; qa?: QaVerdictJson | null }
/** approvals.payload for kind = 'external_action' (ask_ceo, fail_task, qa escalation, tool actions). */
export interface ActionPayload {
  type?: 'question' | 'task_failed' | 'qa_escalation' | string;
  question?: string;
  reason?: string;
  options?: string[];
  action?: string;          // exact action for tool approvals, e.g. "Publish theme 'Bundle v2' to madammuse.co"
  risk?: string;
  on_approve?: string;
  last_verdict?: QaVerdictJson;
}

export interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  request_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  title: string;
  summary: string | null;
  payload: Record<string, unknown>;
  preview_url: string | null;
  status: ApprovalStatus;
  ceo_note: string | null;
  decided_at: string | null;
  decided_via: 'dashboard' | 'telegram' | null;
  created_at: string;
}

export interface ActivityRow {
  id: number;
  actor: string;
  action: string;
  request_id: string | null;
  task_id: string | null;
  client_id: string | null;
  detail: Record<string, unknown>;
  cost_usd: Numeric;
  created_at: string;
}

export interface AgentScreenRow {
  agent_id: string;
  task_id: string | null;
  app: string;
  title: string | null;
  content: string | null;
  image_url: string | null;
  step_note: string | null;
  progress: number | null;
  updated_at: string;
}

/** Everything the dashboard shows, loaded once on the server and kept live by the client store. */
export interface HqSnapshot {
  clients: ClientRow[];
  agents: AgentRow[];
  screens: AgentScreenRow[];
  approvals: ApprovalRow[];
  requests: RequestRow[];
  tasks: TaskRow[];
  activity: ActivityRow[];
  qaReviews: QaReviewRow[];
  loadedAt: string;
}

export type Decision = 'approve' | 'changes' | 'reject';

export type HqMode = 'live' | 'demo';

export interface HqSession {
  mode: HqMode;
  /** Public Supabase config for the browser client (LIVE only). The anon key is public by design. */
  supabase: { url: string; anonKey: string } | null;
  user: { id: string; email: string | null } | null;
  /** False when signed in but not listed in ceo_users (RLS returns nothing). */
  isCeo: boolean;
  chatLive: boolean;
}
