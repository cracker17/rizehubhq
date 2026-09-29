// ConnectorStore: the worker's door to the connector tables (docs/15). Every call goes through the SQL functions in
// supabase/migrations/20260929020000_connectors.sql (service role only for anything touching ciphertext).
import type { SupabaseClient } from '@supabase/supabase-js';
import { fromPgBytea, toPgBytea, type Sealed } from '../vault/crypto';

export type ConnectorKind = 'gmail' | 'mcp' | 'ical' | 'storage';
export type ConnectorStatus = 'active' | 'needs_reauth' | 'error' | 'disabled';
export interface GmailSettings { mode?: 'read' | 'read_draft' | 'read_draft_send' }

export interface ConnectorRow {
  id: string;
  name: string;
  account_email: string | null;
  url: string | null;
  auth_type: string;
  settings: GmailSettings & Record<string, unknown>;
  sealed: Sealed | null;
}
export interface ConnectorFull extends ConnectorRow { kind: ConnectorKind; status: ConnectorStatus }

export interface NewConnector {
  id: string; kind: ConnectorKind; name: string; accountEmail: string | null; url: string | null; authType: string;
  settings: Record<string, unknown>; sealed: Sealed; grants: string[]; catalogKey: string | null;
}

export interface SyncedTool { name: string; description: string; input_schema: Record<string, unknown>; annotations: Record<string, unknown>; policy: string; locked: string | null; badges: string[] }
export interface AgentTool { connector_id: string; name: string; description: string; input_schema: Record<string, unknown>; policy: 'allow' | 'ask' }

export interface ConnectorStore {
  forAgent(agentId: string, kind: ConnectorKind): Promise<ConnectorRow[]>;
  /** MCP: replace the stored tool list (first sync applies the defaults; later new/changed tools arrive off for review). */
  syncTools?(id: string, tools: SyncedTool[], initial: boolean): Promise<number>;
  /** MCP: tools an agent may use now (granted, active, on, reviewed). */
  toolsForAgent?(agentId: string): Promise<AgentTool[]>;
  /** Storage: the connection to save to now (the CEO's default, else the oldest active one), or null. */
  defaultStorage?(): Promise<ConnectorFull | null>;
  get(id: string): Promise<ConnectorFull | null>;
  insert(c: NewConnector): Promise<string>;
  rotate(id: string, sealed: Sealed): Promise<void>;
  mark(id: string, status: 'active' | 'error' | 'needs_reauth', error?: string | null, used?: boolean): Promise<void>;
}

/** Encryption context of a connector secret (never the same as a Client Vault credential's). */
export const connectorContext = (id: string) => `connector:${id}`;

type Raw = Record<string, unknown> & { secret_cipher?: unknown; secret_iv?: unknown; key_version?: number | null };
function sealedOf(r: Raw): Sealed | null {
  if (!r.secret_cipher || !r.secret_iv || !r.key_version) return null;
  return { cipher: fromPgBytea(r.secret_cipher as string), iv: fromPgBytea(r.secret_iv as string), keyVersion: Number(r.key_version) };
}
function rowOf(r: Raw): ConnectorRow {
  return {
    id: String(r.id), name: String(r.name), account_email: (r.account_email as string | null) ?? null, url: (r.url as string | null) ?? null,
    auth_type: String(r.auth_type), settings: (r.settings as ConnectorRow['settings']) ?? {}, sealed: sealedOf(r),
  };
}

export function createSupabaseConnectorStore(db: SupabaseClient): ConnectorStore {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };
  return {
    forAgent: async (agentId, kind) => ((await rpc<Raw[]>('connectors_for_agent', { p_agent: agentId, p_kind: kind })) ?? []).map(rowOf),
    get: async (id) => {
      const rows = (await rpc<Raw[]>('connector_get_sealed', { p_id: id })) ?? [];
      const r = rows[0];
      return r ? { ...rowOf(r), kind: r.kind as ConnectorKind, status: r.status as ConnectorStatus } : null;
    },
    insert: (c) => rpc<string>('connector_insert', {
      p_id: c.id, p_kind: c.kind, p_name: c.name, p_account_email: c.accountEmail, p_url: c.url, p_auth_type: c.authType,
      p_settings: c.settings, p_cipher: toPgBytea(c.sealed.cipher), p_iv: toPgBytea(c.sealed.iv), p_key_version: c.sealed.keyVersion,
      p_grants: c.grants, p_catalog_key: c.catalogKey,
    }),
    rotate: async (id, s) => { await rpc('connector_rotate_secret', { p_id: id, p_cipher: toPgBytea(s.cipher), p_iv: toPgBytea(s.iv), p_key_version: s.keyVersion }); },
    mark: async (id, status, error = null, used = false) => { await rpc('connector_mark', { p_id: id, p_status: status, p_error: error, p_used: used }); },
    syncTools: (id, tools, initial) => rpc<number>('connector_tools_sync', { p_id: id, p_tools: tools, p_initial: initial }),
    toolsForAgent: async (agentId) => ((await rpc<AgentTool[]>('connector_tools_for_agent', { p_agent: agentId })) ?? []),
    defaultStorage: async () => {
      const r = ((await rpc<Raw[]>('storage_default_connector', {})) ?? [])[0];
      return r ? { ...rowOf(r), kind: r.kind as ConnectorKind, status: r.status as ConnectorStatus } : null;
    },
  };
}
