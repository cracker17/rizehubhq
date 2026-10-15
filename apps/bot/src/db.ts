// BotDb: everything the bot reads/writes in Supabase (service role, server-only). Decisions go
// through the decide_approval RPC so the bot and dashboard share one set of rules.
import type { SupabaseClient } from '@supabase/supabase-js';
import { NOTICE_ACTIONS, type OperatorJobLite, type OperatorLoginLite, type OperatorNotice, type OperatorStatus } from './operator';
import type { AgentLite, BotApproval, BotReport, BudgetAlert, Decision, QuickFacts, SpendRow, VoiceNoteState } from './types';

export const APPROVAL_COLS = '*, requests(priority,title,due_date,clients(name))';
const REPORT_COLS = 'id,agent_id,report_date,kind,body_md,data,created_at,telegram_sent_at';
export const BROADCAST_KINDS = ['daily_digest', 'morning_brief', 'weekly', 'operator_morning', 'operator_evening'] as const;

export interface NewRequest { text: string; priority: string; dueDate: string | null; clientSlug: string | null }
export interface NewVoiceNote { chatId: number; messageId: number; audio: Uint8Array; mediaType: string; seconds: number | null }

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
  /** Queues a Telegram voice note for the worker (voice_notes, 20260929050000_voice_notes.sql). Returns its id. */
  createVoiceNote(v: NewVoiceNote): Promise<string>;
  /** Status + transcript (never the audio); null when the row is gone. */
  getVoiceNote(id: string): Promise<VoiceNoteState | null>;
  /** The bot stopped waiting: mark it failed and drop the audio (only while still pending / working). */
  abandonVoiceNote(id: string, error: string): Promise<void>;
  // ---------- Julev Operator (20261015000000_operator.sql) ----------
  /** Operator audit rows that may need a Telegram notice and have not been handled yet (oldest first). */
  unsentOperatorNotices(sinceIso: string): Promise<OperatorNotice[]>;
  markOperatorNoticeSent(id: number): Promise<void>;
  /** The kill switch: no operator sends at all while on. */
  setOperatorPaused(paused: boolean): Promise<void>;
  setOperatorClientPaused(slug: string, paused: boolean): Promise<void>;
  operatorStatus(slug: string): Promise<OperatorStatus | null>;
  operatorClients(): Promise<{ slug: string; name: string }[]>;
  /** Reply drafts waiting for the CEO (pending operator_reply approvals), oldest first. */
  pendingOperatorReplies(limit: number): Promise<{ rows: BotApproval[]; total: number }>;
  // ---------- worker mode (20261016000000_operator_worker.sql) ----------
  /** /task: queues a job for the client (operator_add_job). Returns the job id. */
  addOperatorJob(client: string, brief: string): Promise<string>;
  /** /jobs: open jobs plus the last 2 days' finished ones, newest first. */
  operatorJobs(client: string | null, limit: number): Promise<OperatorJobLite[]>;
  operatorLogins(client: string | null): Promise<OperatorLoginLite[]>;
  /** QA screenshots by id (decoded). */
  operatorEvidence(ids: number[]): Promise<{ id: number; label: string; jpeg: Buffer }[]>;
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
        const { data } = await sb.from('clients').select('id').eq('slug', r.clientSlug).eq('is_internal', false).maybeSingle();
        clientId = (data as { id: string } | null)?.id ?? null;
      }
      const row = must<{ id: string }>(await sb.from('requests')
        .insert({ source: 'telegram', raw_text: r.text, priority: r.priority, due_date: r.dueDate, client_id: clientId }).select('id').single(), 'requests');
      await sb.from('activity_log').insert({ actor: 'ceo', action: 'request.created', request_id: row.id, detail: { source: 'telegram' } });
      return { id: row.id, clientFound: clientId !== null };
    },
    createVoiceNote: async (v) => must<{ id: string }>(await sb.from('voice_notes').insert({
      chat_id: v.chatId, message_id: v.messageId, media_type: v.mediaType, seconds: v.seconds,
      audio: `\\x${Buffer.from(v.audio).toString('hex')}`, // bytea hex input through PostgREST
    }).select('id').single(), 'voice_notes').id,
    getVoiceNote: async (id) => must<VoiceNoteState | null>(await sb.from('voice_notes').select('status,text,error').eq('id', id).maybeSingle(), 'voice_notes'),
    abandonVoiceNote: async (id, error) => {
      must(await sb.from('voice_notes').update({ status: 'failed', error, audio: null }).eq('id', id).in('status', ['pending', 'working']), 'voice_notes');
    },
    unsentOperatorNotices: async (sinceIso) => {
      // operator_inbox(...) is a to-one embed (inbox_id → operator_inbox.id): PostgREST returns an object, not a list.
      const res = await sb.from('operator_actions')
        .select('id,created_at,client_slug,inbox_id,job_id,action,ok,detail,operator_inbox(sender_name,final_text,mode,error,url)')
        .is('telegram_sent_at', null).in('action', [...NOTICE_ACTIONS]).gte('created_at', sinceIso).order('id').limit(20);
      const rows = must<OperatorNotice[]>(res as unknown as { data: OperatorNotice[] | null; error: { message: string } | null }, 'operator_actions');
      const jobIds = [...new Set(rows.map((r) => r.job_id).filter((x): x is string => !!x))];
      if (jobIds.length) {
        const jobs = await sb.from('operator_jobs').select('id,title').in('id', jobIds);
        const titles = new Map(((jobs.data ?? []) as { id: string; title: string }[]).map((j) => [j.id, j.title]));
        for (const r of rows) if (r.job_id) r.job_title = titles.get(r.job_id) ?? null;
      }
      return rows;
    },
    markOperatorNoticeSent: async (id) => {
      must(await sb.from('operator_actions').update({ telegram_sent_at: new Date().toISOString() }).eq('id', id).is('telegram_sent_at', null), 'operator notice sent');
    },
    setOperatorPaused: async (paused) => { must(await sb.rpc('operator_set_paused', { p_paused: paused, p_via: 'telegram' }), 'operator_set_paused'); },
    setOperatorClientPaused: async (slug, paused) => {
      must(await sb.rpc('operator_set_client_paused', { p_client: slug, p_paused: paused, p_via: 'telegram' }), 'operator_set_client_paused');
    },
    operatorStatus: async (slug) => must<OperatorStatus | null>(await sb.rpc('operator_client_status', { p_client: slug }), 'operator_client_status'),
    operatorClients: async () => must<{ slug: string; name: string }[]>(await sb.from('operator_clients').select('slug,name').eq('enabled', true).order('slug'), 'operator_clients'),
    pendingOperatorReplies: async (limit) => {
      const res = await sb.from('approvals').select(APPROVAL_COLS, { count: 'exact' }).eq('status', 'pending')
        .eq('payload->>type', 'operator_reply').order('created_at').limit(limit);
      return { rows: must<BotApproval[]>(res, 'approvals'), total: res.count ?? 0 };
    },
    addOperatorJob: async (client, brief) => must<string>(await sb.rpc('operator_add_job', { p_client: client, p_brief: brief, p_channel: null, p_via: 'telegram' }), 'operator_add_job'),
    operatorJobs: async (client, limit) => {
      let q = sb.from('operator_jobs').select('id,client_slug,title,status,cost_usd,updated_at,error')
        .or(`status.in.(queued,running,waiting,verifying),updated_at.gt.${new Date(Date.now() - 2 * 86400_000).toISOString()}`);
      if (client) q = q.eq('client_slug', client);
      return must<OperatorJobLite[]>(await q.order('updated_at', { ascending: false }).limit(limit), 'operator_jobs');
    },
    operatorLogins: async (client) => {
      let q = sb.from('operator_logins').select('client_slug,site,label,state,last_checked_at,detail').eq('enabled', true);
      if (client) q = q.eq('client_slug', client);
      return must<OperatorLoginLite[]>(await q.order('client_slug').order('site'), 'operator_logins');
    },
    operatorEvidence: async (ids) => {
      const rows = must<{ id: number; label: string; data: string }[]>(await sb.from('operator_evidence').select('id,label,data').in('id', ids).order('id'), 'operator_evidence');
      // bytea comes back hex-encoded ("\\x...") through PostgREST
      return rows.map((r) => ({ id: Number(r.id), label: r.label, jpeg: Buffer.from(String(r.data).replace(/^\\x/, ''), 'hex') })).filter((r) => r.jpeg.length > 0);
    },
  };
}
