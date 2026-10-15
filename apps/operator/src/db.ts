// OperatorDb: everything the operator reads/writes in Supabase (service role). Every state change goes through the
// SQL functions of 20261015000000_operator.sql, which hold the rules (tiers, kill switch, retries); this is a thin door.
import type { SupabaseClient } from '@supabase/supabase-js';
import { manilaMonthStartIso } from 'worker/src/budget';

export interface OperatorClient {
  slug: string;
  name: string;
  client_id: string | null;
  brain_project: string | null;
  profile: string;
  my_names: string[];
  rules: string;
  enabled: boolean;
  paused: boolean;
  /** 'addressed' (default): replies only to messages meant for Julev; 'all': anything that needs a reply. */
  reply_when?: 'addressed' | 'all';
}

export interface OperatorChannel {
  id: string;
  client_slug: string;
  kind: 'google_chat' | 'gmail' | 'slack' | 'teams' | 'whatsapp';
  /** WhatsApp Business: Meta's phone number id (the webhook names it). */
  wa_phone_id?: string | null;
  /** A DM / inbox (counts as addressed to Julev). */
  direct?: boolean;
  /** Found by the unread sweep: read only when the sweep sees it unread. */
  auto_discovered?: boolean;
  account_id?: string | null;
  name: string;
  url: string;
  enabled: boolean;
  last_seen_key: string | null;
  last_polled_at: string | null;
  last_error: string | null;
}

export type InboxStatus = 'new' | 'classifying' | 'fyi' | 'drafted' | 'approved' | 'sending' | 'sent' | 'skipped' | 'failed' | 'blocked';

export interface InboxRow {
  id: string;
  client_slug: string;
  channel_id: string;
  external_id: string;
  thread_key: string | null;
  space_name: string | null;
  sender_name: string;
  body: string;
  sent_at: string | null;
  url: string | null;
  mentions_me: boolean;
  from_me: boolean;
  status: InboxStatus;
  category: string | null;
  mode: string | null;
  analysis: Record<string, unknown>;
  draft: string | null;
  final_text: string | null;
  attempts: number;
}

/** A message as the watcher saw it (before it is stored). */
export interface IngestMessage {
  external_id: string;
  thread_key?: string | null;
  space_name?: string | null;
  sender_name: string;
  body: string;
  sent_at?: string | null;
  url?: string | null;
  mentions_me: boolean;
  from_me: boolean;
  /** Seen on the channel's first poll: stored as history, never answered. */
  baseline?: boolean;
}

export interface UsageEntry { tokensIn: number; tokensOut: number; costUsd: number; detail: Record<string, unknown> }

export interface OperatorDb {
  clients(): Promise<OperatorClient[]>;
  channels(): Promise<OperatorChannel[]>;
  ingest(channelId: string, m: IngestMessage): Promise<string | null>;
  channelPolled(channelId: string, lastKey: string | null, error: string | null): Promise<void>;
  claimNew(): Promise<InboxRow | null>;
  recordDraft(inboxId: string, result: Record<string, unknown>): Promise<string>;
  classifyFailed(inboxId: string, error: string): Promise<string>;
  claimSend(): Promise<InboxRow | null>;
  /** null = may send now; else why not (kill switch, pause, not claimed). */
  maySend(inboxId: string): Promise<string | null>;
  /** final: never retry (Enter may have been pressed, or a person must look). */
  sendDone(inboxId: string, ok: boolean, error: string | null, detail?: Record<string, unknown>, final?: boolean): Promise<string>;
  /** Recent messages of a channel (oldest first), for thread context. */
  history(channelId: string, beforeIso: string | null, limit: number): Promise<InboxRow[]>;
  log(action: string, client: string | null, inboxId: string | null, detail?: Record<string, unknown>, ok?: boolean): Promise<void>;
  /** Project memory from the HQ Brain index (brain_project_bundle); null when the project is not indexed. */
  brainBundle(project: string): Promise<BrainBundle | null>;
  /** Keyword search inside one project (brain_search; curated kinds only, never the profile or raw transcripts). */
  brainSearch(project: string, query: string, limit: number): Promise<BrainHit[]>;
  recordUsage(u: UsageEntry): Promise<void>;
  monthSpendUsd(): Promise<number>;
  spendSinceUsd(sinceIso: string): Promise<number>;
  // ---------- unread sweep (20261017040000_operator_discovery.sql) ----------
  accounts(): Promise<OperatorAccount[]>;
  discover(accountId: string, name: string, url: string, direct: boolean): Promise<{ channel_id: string; created: boolean; enabled: boolean }>;
  accountSwept(accountId: string, found: number, error: string | null): Promise<void>;
  // ---------- send tests (20261017050000_operator_posting.sql) ----------
  claimSendTest(): Promise<{ client_slug: string; kind: 'gmail' | 'slack' | 'teams'; test_url: string } | null>;
  sendTestDone(client: string, kind: string, ok: boolean, detail: string): Promise<string>;
}

export interface OperatorAccount { id: string; client_slug: string; kind: 'google_chat' | 'gmail' | 'slack' | 'teams'; label: string; home_url: string; enabled: boolean; last_swept_at: string | null; last_error: string | null }

export interface BrainBundle {
  project: { slug: string; name: string; status: string | null } | null;
  memory: { body: string } | null;
  sessions: { title: string; doc_date: string | null; body: string }[];
  decisions: { decided_on: string | null; text: string }[];
  next_steps: { text: string; done: boolean }[];
}
export interface BrainHit { path: string; title: string; kind: string; heading: string | null; text: string }

/** What the drafter may read from the brain: curated memory, never Julev's profile or raw Claude transcripts. */
export const BRAIN_KINDS = ['memory', 'session', 'session_log', 'project_doc'] as const;

/** A SQL function returning a composite type answers an all-null object for "none". */
export function rowOrNull<T extends { id: string | null }>(v: unknown): T | null {
  const r = (Array.isArray(v) ? v[0] : v) as T | null | undefined;
  return r && r.id ? r : null;
}

const INBOX_COLS = 'id,client_slug,channel_id,external_id,thread_key,space_name,sender_name,body,sent_at,url,mentions_me,from_me,status,category,mode,analysis,draft,final_text,attempts';

export function createSupabaseOperatorDb(sb: SupabaseClient): OperatorDb {
  async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  }
  async function sumUsage(sinceIso: string): Promise<number> {
    let total = 0;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('activity_log').select('cost_usd').like('action', 'usage.%')
        .gte('created_at', sinceIso).gt('cost_usd', 0).range(from, from + 999);
      if (error) throw new Error(`activity_log: ${error.message}`);
      const rows = (data ?? []) as { cost_usd: number | string }[];
      total += rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
      if (rows.length < 1000) return total;
    }
  }
  return {
    clients: async () => {
      const { data, error } = await sb.from('operator_clients').select('*').eq('enabled', true).order('slug');
      if (error) throw new Error(`operator_clients: ${error.message}`);
      return (data ?? []) as OperatorClient[];
    },
    channels: async () => {
      const { data, error } = await sb.from('operator_channels').select('*').eq('enabled', true).order('created_at');
      if (error) throw new Error(`operator_channels: ${error.message}`);
      return (data ?? []) as OperatorChannel[];
    },
    ingest: (channelId, m) => rpc<string | null>('operator_ingest', { p_channel: channelId, p_msg: m }),
    channelPolled: async (channelId, lastKey, error) => { await rpc('operator_channel_polled', { p_channel: channelId, p_last_key: lastKey, p_error: error }); },
    claimNew: async () => rowOrNull<InboxRow>(await rpc('operator_claim_new')),
    recordDraft: (inboxId, result) => rpc<string>('operator_record_draft', { p_inbox: inboxId, p_result: result }),
    classifyFailed: (inboxId, error) => rpc<string>('operator_classify_failed', { p_inbox: inboxId, p_error: error }),
    claimSend: async () => rowOrNull<InboxRow>(await rpc('operator_claim_send')),
    maySend: (inboxId) => rpc<string | null>('operator_may_send', { p_inbox: inboxId }),
    sendDone: (inboxId, ok, error, detail = {}, final = false) => rpc<string>('operator_send_done', { p_inbox: inboxId, p_ok: ok, p_error: error, p_detail: detail, p_final: final }),
    history: async (channelId, beforeIso, limit) => {
      let q = sb.from('operator_inbox').select(INBOX_COLS).eq('channel_id', channelId);
      if (beforeIso) q = q.lte('sent_at', beforeIso);
      const { data, error } = await q.order('sent_at', { ascending: false, nullsFirst: false }).limit(limit);
      if (error) throw new Error(`operator_inbox: ${error.message}`);
      return ((data ?? []) as InboxRow[]).reverse();
    },
    log: async (action, client, inboxId, detail = {}, ok = true) => {
      await rpc('operator_log', { p_actor: 'operator', p_action: action, p_client: client, p_inbox: inboxId, p_detail: detail, p_ok: ok });
    },
    brainBundle: (project) => rpc<BrainBundle | null>('brain_project_bundle', { p_slug: project, p_sessions: 1 }),
    brainSearch: async (project, query, limit) =>
      (await rpc<BrainHit[] | null>('brain_search', { p_query: query, p_embedding: null, p_project: project, p_kinds: BRAIN_KINDS, p_limit: limit })) ?? [],
    recordUsage: async (u) => {
      await rpc('record_usage', { p_actor: 'operator', p_task: null, p_request: null, p_kind: 'operator',
        p_tokens_in: u.tokensIn, p_tokens_out: u.tokensOut, p_cost: u.costUsd, p_detail: u.detail });
    },
    monthSpendUsd: () => sumUsage(manilaMonthStartIso()),
    spendSinceUsd: sumUsage,
    accounts: async () => {
      const { data, error } = await sb.from('operator_accounts').select('*').eq('enabled', true).order('created_at');
      if (error) throw new Error(`operator_accounts: ${error.message}`);
      return (data ?? []) as OperatorAccount[];
    },
    discover: (accountId, name, url, direct) => rpc('operator_discover', { p_account: accountId, p_name: name, p_url: url, p_direct: direct }),
    accountSwept: async (accountId, found, error) => { await rpc('operator_account_swept', { p_account: accountId, p_found: found, p_error: error }); },
    claimSendTest: async () => {
      const r = await rpc<unknown>('operator_claim_send_test');
      const row = (Array.isArray(r) ? r[0] : r) as { client_slug?: string | null; kind: 'gmail' | 'slack' | 'teams'; test_url: string } | null;
      return row?.client_slug ? (row as { client_slug: string; kind: 'gmail' | 'slack' | 'teams'; test_url: string }) : null;
    },
    sendTestDone: (client, kind, ok, detail) => rpc('operator_send_test_done', { p_client: client, p_kind: kind, p_ok: ok, p_detail: detail }),
  };
}
