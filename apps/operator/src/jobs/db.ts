// JobDb: what worker mode reads/writes in Supabase (service role). Every state change is a SQL function of
// 20261016000000_operator_worker.sql (the rules live there); this is a thin door.
import type { SupabaseClient } from '@supabase/supabase-js';
import { fromPgBytea, open, type Keyring } from 'worker/src/vault/crypto';
import type { Token } from 'worker/src/dev/creds';
import { rowOrNull } from '../db';
import type { Platform } from './apis';
import type { JobActionRow, JobRow, MemoryNote } from './prompt';

export interface OutboxRow {
  id: string; client_slug: string; channel_id: string; inbox_id: string | null; job_id: string | null;
  text: string; mentions: unknown; mode: string; status: string; final_text: string | null; attempts: number;
}
export interface LoginRow { client_slug: string; site: string; label: string; check_url: string; enabled: boolean; state: string; last_checked_at: string | null }

export interface JobDb {
  claimJob(): Promise<JobRow | null>;
  /** Jobs stuck in 'verifying' (the operator restarted between finish and QA). */
  staleVerifying(olderThanMs: number): Promise<JobRow[]>;
  job(id: string): Promise<JobRow | null>;
  actions(jobId: string): Promise<JobActionRow[]>;
  step(jobId: string, action: string, detail?: Record<string, unknown>, ok?: boolean): Promise<void>;
  requestAction(jobId: string, kind: string, summary: string, spec: Record<string, unknown>): Promise<{ action_id: string; approval_id: string }>;
  runDone(jobId: string, outcome: string, result: Record<string, unknown>, costUsd: number, error: string | null): Promise<string>;
  verified(jobId: string, pass: boolean, qa: Record<string, unknown>, feedback: string | null): Promise<string>;
  claimAction(): Promise<JobActionRow | null>;
  actionMayRun(actionId: string): Promise<string | null>;
  actionDone(actionId: string, ok: boolean, result: Record<string, unknown>, error: string | null): Promise<string>;
  queueUpdate(jobId: string, text: string, mentions: string[]): Promise<string>;
  claimUpdate(): Promise<OutboxRow | null>;
  updateMaySend(id: string): Promise<string | null>;
  updateDone(id: string, ok: boolean, error: string | null, detail?: Record<string, unknown>, final?: boolean): Promise<string>;
  inboxMessage(id: string): Promise<{ external_id: string; thread_key: string | null } | null>;
  saveEvidence(jobId: string, label: string, url: string | null, jpeg: Buffer): Promise<number | null>;
  pruneEvidence(days: number): Promise<number>;
  proposeMemory(jobId: string, kind: 'session_note' | 'decision' | 'next_step', text: string): Promise<void>;
  promoteMemory(): Promise<number>;
  recentWork(client: string, limit: number): Promise<MemoryNote[]>;
  logins(): Promise<LoginRow[]>;
  loginChecked(client: string, site: string, state: 'ok' | 'signed_out' | 'error', detail: string | null): Promise<string>;
  /** The client's API token for a platform from the Client Vault (null when none is linked / usable). */
  vaultToken(client: string, platform: Platform, keyring: Keyring | null): Promise<Token | null>;
}

export function createSupabaseJobDb(sb: SupabaseClient): JobDb {
  async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  }
  return {
    claimJob: async () => rowOrNull<JobRow>(await rpc('operator_claim_job')),
    staleVerifying: async (ms) => {
      const { data, error } = await sb.from('operator_jobs').select('*').eq('status', 'verifying').lt('updated_at', new Date(Date.now() - ms).toISOString()).limit(5);
      if (error) throw new Error(`operator_jobs: ${error.message}`);
      return (data ?? []) as JobRow[];
    },
    job: async (id) => {
      const { data, error } = await sb.from('operator_jobs').select('*').eq('id', id).maybeSingle();
      if (error) throw new Error(`operator_jobs: ${error.message}`);
      return (data ?? null) as JobRow | null;
    },
    actions: async (jobId) => {
      const { data, error } = await sb.from('operator_job_actions').select('*').eq('job_id', jobId).order('created_at');
      if (error) throw new Error(`operator_job_actions: ${error.message}`);
      return (data ?? []) as JobActionRow[];
    },
    step: async (jobId, action, detail = {}, ok = true) => { await rpc('operator_job_step', { p_job: jobId, p_action: action, p_detail: detail, p_ok: ok }); },
    requestAction: (jobId, kind, summary, spec) => rpc('operator_request_action', { p_job: jobId, p_kind: kind, p_summary: summary, p_spec: spec }),
    runDone: (jobId, outcome, result, costUsd, error) => rpc('operator_job_run_done', { p_job: jobId, p_outcome: outcome, p_result: result, p_cost: costUsd, p_error: error }),
    verified: (jobId, pass, qa, feedback) => rpc('operator_job_verified', { p_job: jobId, p_pass: pass, p_qa: qa, p_feedback: feedback }),
    claimAction: async () => rowOrNull<JobActionRow>(await rpc('operator_claim_action')),
    actionMayRun: (id) => rpc('operator_action_may_run', { p_action: id }),
    actionDone: (id, ok, result, error) => rpc('operator_action_done', { p_action: id, p_ok: ok, p_result: result, p_error: error }),
    queueUpdate: (jobId, text, mentions) => rpc('operator_queue_update', { p_job: jobId, p_text: text, p_mentions: mentions }),
    claimUpdate: async () => rowOrNull<OutboxRow>(await rpc('operator_claim_update')),
    updateMaySend: (id) => rpc('operator_update_may_send', { p_outbox: id }),
    updateDone: (id, ok, error, detail = {}, final = false) => rpc('operator_update_done', { p_outbox: id, p_ok: ok, p_error: error, p_detail: detail, p_final: final }),
    inboxMessage: async (id) => {
      const { data, error } = await sb.from('operator_inbox').select('external_id,thread_key').eq('id', id).maybeSingle();
      if (error) throw new Error(`operator_inbox: ${error.message}`);
      return (data ?? null) as { external_id: string; thread_key: string | null } | null;
    },
    saveEvidence: async (jobId, label, url, jpeg) => {
      if (!jpeg.length || jpeg.length > 1_572_864) return null;
      const { data, error } = await sb.from('operator_evidence')
        .insert({ job_id: jobId, label: label.slice(0, 120), url: url?.slice(0, 2000) ?? null, mime: 'image/jpeg', data: `\\x${jpeg.toString('hex')}` })
        .select('id').single();
      if (error) throw new Error(`operator_evidence: ${error.message}`);
      return Number((data as { id: number }).id);
    },
    pruneEvidence: (days) => rpc('operator_evidence_prune', { p_days: days }),
    proposeMemory: async (jobId, kind, text) => { await rpc('operator_propose_memory', { p_job: jobId, p_kind: kind, p_text: text }); },
    promoteMemory: () => rpc('operator_memory_promote'),
    recentWork: async (client, limit) => {
      const { data, error } = await sb.from('operator_memory').select('kind,text,status,created_at').eq('client_slug', client)
        .neq('status', 'rejected').order('created_at', { ascending: false }).limit(limit);
      if (error) throw new Error(`operator_memory: ${error.message}`);
      return (data ?? []) as MemoryNote[];
    },
    logins: async () => {
      const { data, error } = await sb.from('operator_logins').select('*').eq('enabled', true).order('client_slug');
      if (error) throw new Error(`operator_logins: ${error.message}`);
      return (data ?? []) as LoginRow[];
    },
    loginChecked: (client, site, state, detail) => rpc('operator_login_checked', { p_client: client, p_site: site, p_state: state, p_detail: detail }),
    vaultToken: async (client, platform, keyring) => {
      const { data, error } = await sb.rpc('operator_credential', { p_client: client, p_platform: platform });
      if (error) throw new Error(`operator_credential: ${error.message}`);
      const c = (Array.isArray(data) ? data[0] : data) as { id: string; secret_cipher: unknown; secret_iv: unknown; key_version: number; url_allowlist: string[] | null } | undefined;
      if (!c?.id || !keyring) return null;
      const token = open({ cipher: fromPgBytea(c.secret_cipher), iv: fromPgBytea(c.secret_iv), keyVersion: Number(c.key_version) }, keyring, c.id);
      return { token, source: 'vault', credentialId: c.id, allowlist: c.url_allowlist ?? [] };
    },
  };
}
