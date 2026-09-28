// SalesDb: the worker's door to the sales pipeline tables. Every write goes through the RPCs in
// supabase/migrations/20260928090000_sales_pipeline.sql (argument names must match the SQL; the integration suite
// checks every rpc() call site). Reads are small selects.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LeadEmailStatus, LeadStage } from '@rizehubhq/shared';
import type { LeadSource } from './sources';

export type EmailKind = 'first_touch' | 'follow_up' | 'reply' | 'proposal';
/** lead_emails.status: the shared enum (packages/shared/src/status.ts mirrors the migration's check constraint). */
export type EmailStatus = LeadEmailStatus;
export const REPLY_CLASSES = ['interested', 'question', 'not_now', 'not_interested', 'unsubscribe'] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

export interface LeadInput {
  business_name: string; website?: string | null; contact_name?: string | null; contact_role?: string | null; email?: string | null;
  email_source_url?: string | null; source: LeadSource; source_url?: string | null; rizehub_lead_id?: string | null;
  platform?: string | null; location?: string | null; country?: string | null; research?: Record<string, unknown>; score?: number | null;
}
export interface LeadRow {
  id: string; business_name: string; website: string | null; contact_name: string | null; contact_role: string | null; email: string | null;
  email_source_url: string | null; source: LeadSource; source_url: string | null; rizehub_lead_id: string | null; platform: string | null;
  location: string | null; country: string | null; research: Record<string, unknown>; stage: LeadStage; score: number | null;
  next_follow_up_at: string | null; follow_up_count: number; first_contacted_at: string | null; last_contacted_at: string | null;
  replied_at: string | null; lost_reason: string | null; client_id: string | null; created_at: string; updated_at: string;
}
export interface LeadEmailRow {
  id: string; lead_id: string; direction: 'out' | 'in'; kind: EmailKind; follow_up_number: number | null; to_email: string | null;
  from_email: string | null; subject: string; body: string; status: EmailStatus; flags: string[]; needs_explicit_approval: boolean;
  approval_id: string | null; message_id: string | null; in_reply_to: string | null; classification: ReplyClass | null;
  classified_by: 'heuristic' | 'model' | 'ceo' | null; auto_reply: boolean; ceo_note: string | null; last_error: string | null;
  created_at: string; sent_at: string | null; received_at: string | null;
}
export interface DraftResult { id: string; status: EmailStatus; flags: string[]; needs_explicit_approval: boolean; replaced: boolean }
export interface ClaimedEmail {
  id: string; lead_id: string; kind: EmailKind; follow_up_number: number | null; to: string; subject: string; body: string;
  in_reply_to: string | null; references: string[]; approval_id: string | null; attempt: number;
}
export interface ClaimedLead { id: string; business_name: string; contact_name: string | null; email: string | null; source: LeadSource; email_source_url: string | null; stage: LeadStage }
export type ClaimResult =
  | { status: 'claimed'; sent_today: number; cap: number; email: ClaimedEmail; lead: ClaimedLead }
  | { status: 'cap_reached' | 'idle'; sent_today: number; cap: number };
export interface InboundRecord {
  message_id: string | null; in_reply_to: string | null; references: string[]; from: string; subject: string; body: string;
  received_at: string | null; classification: ReplyClass | null; classified_by: 'heuristic' | 'model' | null; auto_reply: boolean;
}

export interface SalesDb {
  upsertLead(p: LeadInput, taskId: string | null): Promise<{ id: string; created: boolean; stage: LeadStage }>;
  updateResearch(leadId: string, research: Record<string, unknown>, score: number | null): Promise<{ id: string; stage: LeadStage; score: number | null }>;
  addEmailDraft(leadId: string, kind: EmailKind, subject: string, body: string, taskId: string | null, flags: string[]): Promise<DraftResult>;
  requestEmailApproval(emailId: string, auto: boolean): Promise<{ approval_id: string; auto_approved: boolean; status: EmailStatus }>;
  moveStage(leadId: string, stage: LeadStage, actor: string, note: string | null): Promise<Record<string, unknown>>;
  listLeads(q: { stages?: LeadStage[]; search?: string; ids?: string[]; limit?: number }): Promise<LeadRow[]>;
  listEmails(q: { leadIds?: string[]; statuses?: EmailStatus[]; limit?: number }): Promise<LeadEmailRow[]>;
  createDailyBatch(day: string | null, force: boolean): Promise<string | null>;
  claimSend(cap: number): Promise<ClaimResult>;
  markSent(emailId: string, messageId: string, from: string | null): Promise<Record<string, unknown>>;
  markSendFailed(emailId: string, error: string, retryable: boolean): Promise<{ final: boolean; attempts: number }>;
  recordInbound(p: InboundRecord): Promise<Record<string, unknown>>;
  queueFollowUps(): Promise<{ closed_no_response: number; queued: number; request_id?: string | null }>;
  suppress(email: string, reason: string, source: 'reply' | 'link' | 'ceo' | 'bounce' | 'import', leadId: string | null): Promise<Record<string, unknown>>;
  isSuppressed(email: string): Promise<boolean>;
  /** First email ever sent (warm-up start when OUTREACH_WARMUP_START is unset). */
  firstSentAt(): Promise<string | null>;
  getSetting(key: string): Promise<unknown>;
  setSetting(key: string, value: unknown): Promise<void>;
}

export const LEAD_COLS = 'id,business_name,website,contact_name,contact_role,email,email_source_url,source,source_url,rizehub_lead_id,platform,location,country,research,stage,score,next_follow_up_at,follow_up_count,first_contacted_at,last_contacted_at,replied_at,lost_reason,client_id,created_at,updated_at';
export const EMAIL_COLS = 'id,lead_id,direction,kind,follow_up_number,to_email,from_email,subject,body,status,flags,needs_explicit_approval,approval_id,message_id,in_reply_to,classification,classified_by,auto_reply,ceo_note,last_error,created_at,sent_at,received_at';

export function salesSupabaseDb(sb: SupabaseClient): SalesDb {
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
    upsertLead: (p, taskId) => rpc('sales_upsert_lead', { p, p_task: taskId }),
    updateResearch: (leadId, research, score) => rpc('sales_update_research', { p_lead: leadId, p_research: research, p_score: score }),
    addEmailDraft: (leadId, kind, subject, body, taskId, flags) => rpc('sales_add_email_draft', {
      p_lead: leadId, p_kind: kind, p_subject: subject, p_body: body, p_task: taskId, p_flags: flags,
    }),
    requestEmailApproval: (emailId, auto) => rpc('sales_request_email_approval', { p_email: emailId, p_auto: auto }),
    moveStage: (leadId, stage, actor, note) => rpc('sales_move_stage', { p_lead: leadId, p_stage: stage, p_actor: actor, p_note: note }),
    listLeads: (q) => {
      let query = sb.from('leads').select(LEAD_COLS);
      if (q.stages?.length) query = query.in('stage', q.stages);
      if (q.ids?.length) query = query.in('id', q.ids);
      if (q.search) {
        const s = q.search.replace(/[%,()*]/g, ' ').trim();
        if (s) query = query.or(`business_name.ilike.%${s}%,website.ilike.%${s}%,email.ilike.%${s}%`);
      }
      return rows<LeadRow>(query.order('updated_at', { ascending: false }).limit(q.limit ?? 100), 'leads');
    },
    listEmails: (q) => {
      let query = sb.from('lead_emails').select(EMAIL_COLS);
      if (q.leadIds?.length) query = query.in('lead_id', q.leadIds);
      if (q.statuses?.length) query = query.in('status', q.statuses);
      return rows<LeadEmailRow>(query.order('created_at', { ascending: false }).limit(q.limit ?? 200), 'lead_emails');
    },
    createDailyBatch: async (day, force) => (await rpc<string | null>('sales_create_daily_batch', { p_day: day, p_force: force })) ?? null,
    claimSend: (cap) => rpc('sales_claim_send', { p_cap: cap }),
    markSent: (emailId, messageId, from) => rpc('sales_mark_sent', { p_email: emailId, p_message_id: messageId, p_from: from }),
    markSendFailed: (emailId, error, retryable) => rpc('sales_mark_send_failed', { p_email: emailId, p_error: error, p_retryable: retryable }),
    recordInbound: (p) => rpc('sales_record_inbound', { p }),
    queueFollowUps: () => rpc('queue_sales_follow_ups', {}),
    suppress: (email, reason, source, leadId) => rpc('sales_suppress', { p_email: email, p_reason: reason, p_source: source, p_lead: leadId }),
    isSuppressed: async (email) => {
      const { data, error } = await sb.from('email_suppression').select('id').eq('email', email.trim().toLowerCase()).limit(1);
      if (error) throw new Error(`email_suppression: ${error.message}`);
      return (data ?? []).length > 0;
    },
    firstSentAt: async () => {
      const list = await rows<{ sent_at: string }>(sb.from('lead_emails').select('sent_at').eq('status', 'sent').order('sent_at').limit(1), 'lead_emails');
      return list[0]?.sent_at ?? null;
    },
    getSetting: async (key) => {
      const { data, error } = await sb.from('settings').select('value').eq('key', key).maybeSingle();
      if (error) throw new Error(`settings: ${error.message}`);
      return (data as { value: unknown } | null)?.value ?? null;
    },
    setSetting: async (key, value) => {
      const { error } = await sb.from('settings').upsert({ key, value }, { onConflict: 'key' });
      if (error) throw new Error(`settings: ${error.message}`);
    },
  };
}
