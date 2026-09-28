// BotDb: everything the bot reads/writes in Supabase (service role, server-only). Decisions go
// through the decide_approval RPC so the bot and dashboard share one set of rules.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentLite, BotApproval, BotReport, BudgetAlert, Decision, QuickFacts, SpendRow } from './types';

export const APPROVAL_COLS = '*, requests(priority,title,due_date,clients(name))';
const REPORT_COLS = 'id,agent_id,report_date,kind,body_md,data,created_at,telegram_sent_at';
export const BROADCAST_KINDS = ['daily_digest', 'morning_brief', 'weekly'] as const;

export interface NewRequest { text: string; priority: string; dueDate: string | null; clientSlug: string | null }

export interface BotDb {
  getSettings(): Promise<Record<string, unknown>>;
  setPaused(paused: boolean): Promise<void>;
  unsentApprovals(limit: number): Promise<BotApproval[]>;
  pendingApprovals(limit: number): Promise<{ rows: BotApproval[]; total: number }>;
  getApproval(id: string): Promise<BotApproval | null>;
  /** Stores the Telegram message id once (only if none is stored yet). */
  setApprovalMessageId(id: string, messageId: number): Promise<void>;
  decide(id: string, decision: Decision, note: string | null): Promise<string>;
  decidedSince(sinceIso: string): Promise<BotApproval[]>;
  unsentReports(sinceIso: string): Promise<BotReport[]>;
  markReportSent(id: string): Promise<void>;
  /** Daily-budget alerts not yet sent to Telegram (oldest first). */
  unsentBudgetAlerts(): Promise<BudgetAlert[]>;
  markBudgetAlertSent(id: string): Promise<void>;
  latestReport(kind: BotReport['kind'], date: string): Promise<BotReport | null>;
  reportFacts(date: string): Promise<QuickFacts>;
  spendRows(sinceIso: string): Promise<SpendRow[]>;
  agents(): Promise<AgentLite[]>;
  createRequest(r: NewRequest): Promise<{ id: string; clientFound: boolean }>;
}

export function createSupabaseBotDb(sb: SupabaseClient): BotDb {
  const must = <T>(res: { data: T | null; error: { message: string } | null }, what: string): T => {
    if (res.error) throw new Error(`${what}: ${res.error.message}`);
    return res.data as T;
  };
  return {
    getSettings: async () => Object.fromEntries(
      must<{ key: string; value: unknown }[]>(await sb.from('settings').select('key,value'), 'settings').map((r) => [r.key, r.value])),
    setPaused: async (paused) => { must(await sb.rpc('set_paused', { p_paused: paused, p_via: 'telegram' }), 'set_paused'); },
    unsentApprovals: async (limit) => must<BotApproval[]>(await sb.from('approvals').select(APPROVAL_COLS)
      .eq('status', 'pending').is('telegram_message_id', null).order('created_at').limit(limit), 'approvals'),
    pendingApprovals: async (limit) => {
      const res = await sb.from('approvals').select(APPROVAL_COLS, { count: 'exact' }).eq('status', 'pending').order('created_at').limit(limit);
      return { rows: must<BotApproval[]>(res, 'approvals'), total: res.count ?? 0 };
    },
    getApproval: async (id) => must<BotApproval | null>(await sb.from('approvals').select(APPROVAL_COLS).eq('id', id).maybeSingle(), 'approval'),
    setApprovalMessageId: async (id, messageId) => {
      must(await sb.from('approvals').update({ telegram_message_id: messageId }).eq('id', id).is('telegram_message_id', null), 'approval message id');
    },
    decide: async (id, decision, note) => String(must(await sb.rpc('decide_approval',
      { p_approval: id, p_decision: decision, p_note: note, p_via: 'telegram' }), 'decide_approval')),
    decidedSince: async (sinceIso) => must<BotApproval[]>(await sb.from('approvals').select(APPROVAL_COLS)
      .neq('status', 'pending').gt('decided_at', sinceIso).gt('telegram_message_id', 0).order('decided_at').limit(50), 'decided approvals'),
    unsentReports: async (sinceIso) => must<BotReport[]>(await sb.from('reports').select(REPORT_COLS)
      .in('kind', [...BROADCAST_KINDS]).is('telegram_sent_at', null).gte('created_at', sinceIso).order('created_at').limit(5), 'reports'),
    markReportSent: async (id) => {
      must(await sb.from('reports').update({ telegram_sent_at: new Date().toISOString() }).eq('id', id).is('telegram_sent_at', null), 'report sent');
    },
    unsentBudgetAlerts: async () => must<BudgetAlert[]>(await sb.from('budget_alerts').select('*')
      .is('telegram_sent_at', null).order('alert_day').order('level').limit(10), 'budget_alerts'),
    markBudgetAlertSent: async (id) => {
      must(await sb.from('budget_alerts').update({ telegram_sent_at: new Date().toISOString() }).eq('id', id).is('telegram_sent_at', null), 'budget alert sent');
    },
    latestReport: async (kind, date) => must<BotReport | null>(await sb.from('reports').select(REPORT_COLS)
      .eq('kind', kind).eq('report_date', date).order('created_at', { ascending: false }).limit(1).maybeSingle(), 'report'),
    reportFacts: async (date) => must<QuickFacts>(await sb.rpc('report_facts', { p_from: date, p_days: 1 }), 'report_facts'),
    spendRows: async (sinceIso) => must<SpendRow[]>(await sb.from('activity_log').select('actor,cost_usd,created_at')
      .gt('cost_usd', 0).gte('created_at', sinceIso), 'activity_log'),
    agents: async () => must<AgentLite[]>(await sb.from('agents').select('id,name,status,enabled').eq('enabled', true).order('name'), 'agents'),
    createRequest: async (r) => {
      let clientId: string | null = null;
      if (r.clientSlug) {
        const { data } = await sb.from('clients').select('id').eq('slug', r.clientSlug).maybeSingle();
        clientId = (data as { id: string } | null)?.id ?? null;
      }
      const row = must<{ id: string }>(await sb.from('requests')
        .insert({ source: 'telegram', raw_text: r.text, priority: r.priority, due_date: r.dueDate, client_id: clientId }).select('id').single(), 'requests');
      await sb.from('activity_log').insert({ actor: 'ceo', action: 'request.created', request_id: row.id, detail: { source: 'telegram' } });
      return { id: row.id, clientFound: clientId !== null };
    },
  };
}
