// Row shapes the bot reads (supabase/migrations/*.sql). Numeric columns can arrive as strings.
export type Decision = 'approve' | 'changes' | 'reject';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested';

export interface BotApproval {
  id: string;
  kind: 'plan' | 'deliverable' | 'external_action';
  request_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  title: string;
  summary: string | null;
  payload: Record<string, unknown> | null;
  preview_url: string | null;
  status: ApprovalStatus;
  ceo_note: string | null;
  decided_at: string | null;
  decided_via: 'dashboard' | 'telegram' | null;
  telegram_message_id: number | null;
  created_at: string;
  /** Embedded parent request (PostgREST `requests(...)`). */
  requests?: { priority: string | null; title: string | null; due_date: string | null; clients?: { name: string } | null } | null;
}

export interface BotReport {
  id: string;
  agent_id: string | null;
  report_date: string;
  kind: 'standup' | 'daily_digest' | 'morning_brief' | 'weekly';
  body_md: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
  telegram_sent_at: string | null;
}

export interface SpendRow { actor: string; cost_usd: number | string; created_at: string }

/** budget_alerts row (20260928080000_six_agent_roster.sql): written by the worker at 80% / 100% of the daily AI budget. */
export interface BudgetAlert {
  id: string;
  alert_day: string;
  level: number;
  spent_usd: number | string;
  budget_usd: number | string;
  created_at: string;
  telegram_sent_at: string | null;
}
export interface AgentLite { id: string; name: string; status: string; enabled?: boolean }

/** The parts of report_facts() the bot's quick /report summary uses. */
export interface QuickFacts {
  spend_usd: number | string;
  qa: { reviews: number; passed: number };
  done: { title: string; agent_id: string; client_name?: string | null }[];
  in_progress: { title: string; agent_id: string; status?: string }[];
  blocked: { title: string; agent_id: string; reason: string }[];
  approvals_waiting: { title: string; kind: string }[];
}
