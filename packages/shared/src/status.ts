// Mirrors the Postgres enums in supabase/migrations. Keep in sync (CLAUDE.md rule 3).
export const REQUEST_STATUS = ['staged','planning','plan_review','in_progress','awaiting_ceo','done','rejected','cancelled','failed'] as const;
export const TASK_STATUS = ['pending','queued','working','qa_pending','qa_reviewing','revision','awaiting_ceo','done','failed','cancelled'] as const;
export const AGENT_STATUS = ['idle','working','waiting','blocked','offline'] as const;
export const APPROVAL_STATUS = ['pending','approved','rejected','changes_requested'] as const;
export const APPROVAL_KIND = ['plan','deliverable','external_action'] as const;
// Model roles resolve to a model through config/models.yaml (docs/14). design/writer/sales were added with the
// six-agent roster; specialist/reports stay for older profiles and for report phrasing.
export const MODEL_ROLES = ['lead','specialist','dev','design','writer','sales','reports','qa','light'] as const;
/** Where an agent's task loop runs: the worker's AI SDK runner, or a Hermes Agent instance (docs/04). */
export const AGENT_RUNTIME = ['worker','hermes'] as const;
export const IDLE_ACTIVITIES = ['coffee','lounge_sofa','lobby','ping_pong','foosball','chat'] as const;

export type RequestStatus = (typeof REQUEST_STATUS)[number];
export type TaskStatus = (typeof TASK_STATUS)[number];
export type AgentStatus = (typeof AGENT_STATUS)[number];
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number];
export type ApprovalKind = (typeof APPROVAL_KIND)[number];
export type ModelRole = (typeof MODEL_ROLES)[number];
export type AgentRuntime = (typeof AGENT_RUNTIME)[number];
export type IdleActivity = (typeof IDLE_ACTIVITIES)[number];
