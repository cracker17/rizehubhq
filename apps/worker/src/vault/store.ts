// VaultStore: the worker's door to the Client Vault tables. Every call goes through the SQL functions in
// supabase/migrations/20260928040000_client_vault.sql (service role only for anything touching ciphertext).
import type { SupabaseClient } from '@supabase/supabase-js';
import { fromPgBytea, toPgBytea, type Sealed } from './crypto';

export type SecretType = 'password' | 'api_token' | 'app_password' | 'ssh_key' | 'other';
export type TwofaMethod = 'none' | 'sms' | 'email' | 'app' | 'collaborator';
export type CredentialStatus = 'active' | 'check_needed' | 'expiring' | 'revoked';

/** Metadata an agent may see (never ciphertext). */
export interface CredentialMeta {
  id: string;
  platform: string;
  label: string;
  login_url: string | null;
  username: string | null;
  secret_type: SecretType;
  twofa_method: TwofaMethod;
  scope_notes: string | null;
  url_allowlist: string[];
  /** "METHOD /path-prefix" entries vault_api may write to; empty = read-only (GET/HEAD). */
  write_allowlist: string[];
  status: CredentialStatus;
  expires_at?: string | null;
  last_used_at?: string | null;
}

/** A credential the agent is granted, with the sealed secret (decrypted only inside the worker). */
export interface CredentialForUse extends CredentialMeta { client_id: string; sealed: Sealed; failed_login_count: number }

export interface AgentCredentialList {
  /** null when listing for a task without a client (only the agency's tool logins). */
  client: { id: string; name: string; slug: string; status: string; is_internal?: boolean } | null;
  granted: CredentialMeta[];
  not_granted: number;
  /** The agency's own tool logins (the internal client, Admin → Tool logins) granted to this agent: usable in any task. */
  tools: CredentialMeta[];
  tools_not_granted: number;
}

export interface NewCredential {
  id: string;
  clientId: string;
  platform: string;
  label: string;
  loginUrl: string | null;
  username: string | null;
  secretType: SecretType;
  sealed: Sealed;
  twofaMethod: TwofaMethod;
  scopeNotes: string | null;
  urlAllowlist: string[];
  /** Default: read-only. */
  writeAllowlist?: string[];
  expiresAt: string | null;
  grants: string[];
}

export type AccessLinkState = { state: 'open' | 'used' | 'expired' | 'invalid'; client_name?: string; platforms?: string[]; expires_at?: string; note?: string | null };

export interface AccessLogEntry {
  credentialId: string | null;
  agentId: string | null;
  taskId: string | null;
  action: string;
  success: boolean;
  /** Never secrets: status codes, hosts, reasons. */
  detail?: Record<string, unknown>;
}

/** 'no_code': approved without a usable code; 'expired': the tool gave up (vault_expire_2fa). */
export type TwofaAnswer =
  | { status: 'pending' | 'rejected' | 'changes_requested' | 'used' | 'no_code' | 'expired' }
  | { status: 'approved'; code: string };

/** Raised by the database for grant / status refusals ("vault: not granted", "vault: revoked", …). */
export class VaultDenied extends Error {}

export interface VaultStore {
  insertCredential(c: NewCredential): Promise<string>;
  /** null when the token is unknown, used, cancelled or expired. */
  redeemAccessRequest(tokenHash: string, c: Omit<NewCredential, 'clientId' | 'urlAllowlist' | 'writeAllowlist' | 'expiresAt' | 'grants'>): Promise<string | null>;
  accessRequestState(tokenHash: string): Promise<AccessLinkState>;
  rotateSecret(id: string, sealed: Sealed): Promise<void>;
  /** CEO reveal/rotate: no grant check (the dashboard re-authenticated the CEO). */
  getSealed(id: string): Promise<{ id: string; label: string; status: CredentialStatus; sealed: Sealed } | null>;
  /** Throws VaultDenied unless the agent is granted and the credential is usable. */
  getForAgent(id: string, agentId: string): Promise<CredentialForUse>;
  /** clientId null = a task without a client: only the tool logins (20260929060000_internal_vault.sql). */
  listForAgent(agentId: string, clientId: string | null): Promise<AgentCredentialList>;
  resolveClientId(ref: string): Promise<string | null>;
  logAccess(e: AccessLogEntry): Promise<void>;
  reportProblem(id: string, agentId: string, taskId: string | null, issue: string): Promise<string>;
  request2fa(id: string, agentId: string, taskId: string | null, question: string): Promise<string>;
  take2faCode(approvalId: string): Promise<TwofaAnswer>;
  /** The tool stopped waiting: a pending question is closed (late answers are refused) and any code is scrubbed. */
  expire2fa(approvalId: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);

function denyOrThrow(fn: string, message: string): never {
  const m = /vault: ([a-z ]+)/.exec(message);
  if (m) throw new VaultDenied(m[1]!);
  throw new Error(`${fn}: ${message}`);
}

export function createSupabaseVaultStore(sb: SupabaseClient): VaultStore {
  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await sb.rpc(fn, args);
    if (error) denyOrThrow(fn, error.message);
    return data as T;
  }
  const one = <T>(data: unknown): T | null => ((Array.isArray(data) ? data[0] : data) as T | undefined) ?? null;
  const credArgs = (c: Omit<NewCredential, 'clientId' | 'urlAllowlist' | 'writeAllowlist' | 'expiresAt' | 'grants'>) => ({
    p_id: c.id, p_platform: c.platform, p_label: c.label, p_login_url: c.loginUrl, p_username: c.username,
    p_secret_type: c.secretType, p_cipher: toPgBytea(c.sealed.cipher), p_iv: toPgBytea(c.sealed.iv),
    p_key_version: c.sealed.keyVersion, p_twofa: c.twofaMethod, p_scope_notes: c.scopeNotes,
  });

  return {
    insertCredential: (c) => rpc<string>('vault_insert_credential', {
      ...credArgs(c), p_client: c.clientId, p_url_allowlist: c.urlAllowlist, p_expires_at: c.expiresAt,
      p_created_by: 'ceo', p_grants: c.grants, p_write_allowlist: c.writeAllowlist ?? [],
    }),
    redeemAccessRequest: async (tokenHash, c) => (await rpc<string | null>('vault_redeem_access_request', { p_token_hash: tokenHash, ...credArgs(c) })) ?? null,
    accessRequestState: (tokenHash) => rpc<AccessLinkState>('vault_access_request_state', { p_token_hash: tokenHash }),
    rotateSecret: async (id, s) => {
      await rpc('vault_rotate_secret', { p_id: id, p_cipher: toPgBytea(s.cipher), p_iv: toPgBytea(s.iv), p_key_version: s.keyVersion });
    },
    getSealed: async (id) => {
      const r = one<{ id: string; label: string; status: CredentialStatus; secret_cipher: unknown; secret_iv: unknown; key_version: number }>(
        await rpc('vault_get_sealed', { p_credential: id }));
      if (!r?.id) return null;
      return { id: r.id, label: r.label, status: r.status, sealed: { cipher: fromPgBytea(r.secret_cipher), iv: fromPgBytea(r.secret_iv), keyVersion: r.key_version } };
    },
    getForAgent: async (id, agentId) => {
      const r = one<Record<string, unknown>>(await rpc('vault_get_for_agent', { p_credential: id, p_agent: agentId }));
      if (!r?.id) throw new VaultDenied('credential not found');
      const { secret_cipher, secret_iv, key_version, ...meta } = r;
      return {
        ...(meta as unknown as Omit<CredentialForUse, 'sealed'>),
        url_allowlist: (meta.url_allowlist as string[] | null) ?? [],
        write_allowlist: (meta.write_allowlist as string[] | null) ?? [],
        sealed: { cipher: fromPgBytea(secret_cipher), iv: fromPgBytea(secret_iv), keyVersion: Number(key_version) },
      };
    },
    listForAgent: async (agentId, clientId) => {
      const l = await rpc<AgentCredentialList>('vault_list_for_agent', { p_agent: agentId, p_client: clientId });
      const norm = (list: CredentialMeta[] | null | undefined) =>
        (list ?? []).map((c) => ({ ...c, url_allowlist: c.url_allowlist ?? [], write_allowlist: c.write_allowlist ?? [] }));
      return { ...l, client: l.client ?? null, granted: norm(l.granted), tools: norm(l.tools), tools_not_granted: l.tools_not_granted ?? 0 };
    },
    resolveClientId: async (ref) => {
      const q = sb.from('clients').select('id');
      const { data, error } = await (isUuid(ref) ? q.eq('id', ref) : q.or(`slug.eq.${ref.replace(/[^a-z0-9-]/gi, '')},name.ilike.${ref.replace(/[^a-z0-9 .&'-]/gi, '')}`)).limit(1);
      if (error) throw new Error(`clients: ${error.message}`);
      return (data?.[0] as { id: string } | undefined)?.id ?? null;
    },
    logAccess: async (e) => {
      await rpc('vault_log_access', {
        p_credential: e.credentialId, p_agent: e.agentId, p_task: e.taskId, p_action: e.action, p_success: e.success, p_detail: e.detail ?? {},
      });
    },
    reportProblem: (id, agentId, taskId, issue) => rpc<string>('vault_report_problem', { p_credential: id, p_agent: agentId, p_task: taskId, p_issue: issue }),
    request2fa: (id, agentId, taskId, question) => rpc<string>('vault_request_2fa', { p_credential: id, p_agent: agentId, p_task: taskId, p_question: question }),
    take2faCode: (approvalId) => rpc<TwofaAnswer>('vault_take_2fa_code', { p_approval: approvalId }),
    expire2fa: async (approvalId) => { await rpc('vault_expire_2fa', { p_approval: approvalId }); },
  };
}
