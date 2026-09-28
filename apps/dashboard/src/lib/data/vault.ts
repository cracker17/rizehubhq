import 'server-only';
// Clients, Client Vault, Connections and Agents pages (docs/06 §7, §7a, §8, §9; docs/09 "Client Vault").
// LIVE: read as the signed-in CEO (RLS); client_credentials is read by explicit safe columns only
// (secret_cipher / secret_iv are not even selectable by `authenticated`). Secrets never pass through here.
// DEMO: an in-memory store (./vaultDemo) so every action works without a database.
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv, workerEnv } from '@/lib/env';
import { demoVault } from './vaultDemo';

// ---------- types (import with `import type` from client components) ----------
export type CredentialStatus = 'active' | 'check_needed' | 'expiring' | 'revoked';
export type SecretType = 'password' | 'api_token' | 'app_password' | 'ssh_key' | 'other';
export type TwofaMethod = 'none' | 'sms' | 'email' | 'app' | 'collaborator';

export interface VaultClient {
  id: string;
  name: string;
  slug: string;
  platforms: string[];
  website: string | null;
  service_package: string | null;
  status: 'active' | 'paused' | 'archived' | string;
  notes: string | null;
  rizehub_workspace_id: string | null;
  created_at: string;
}

export interface ClientSummary extends VaultClient {
  openRequests: number;
  spendMonth: number;
  credentials: number;
  attention: number;
  openLinks: number;
}

export interface CredentialView {
  id: string;
  client_id: string;
  platform: string;
  label: string;
  login_url: string | null;
  username: string | null;
  secret_type: SecretType;
  twofa_method: TwofaMethod;
  scope_notes: string | null;
  url_allowlist: string[];
  /** "METHOD /path-prefix" writes vault_api may make; empty = read-only (GET/HEAD). */
  write_allowlist: string[];
  status: CredentialStatus;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_by: string | null;
  failed_login_count: number;
  created_by: string;
  created_at: string;
  revoked_at?: string | null;
  grants: string[];
}

export interface AccessLogView {
  id: number;
  credential_id: string | null;
  agent_id: string | null;
  action: string;
  success: boolean;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface AccessLinkView {
  id: string;
  client_id: string;
  platforms: string[];
  expires_at: string;
  used_at: string | null;
  created_at: string;
  note: string | null;
  credential_id: string | null;
  cancelled_at: string | null;
}

export interface ClientRequestView {
  id: string;
  title: string | null;
  raw_text: string;
  status: string;
  priority: string;
  cost_usd: number;
  created_at: string;
  due_date: string | null;
}

export interface ClientDetail {
  client: VaultClient;
  credentials: CredentialView[];
  log: AccessLogView[];
  links: AccessLinkView[];
  requests: ClientRequestView[];
}

export interface ConnectionsData {
  clients: { id: string; name: string; platforms: string[]; status: string }[];
  credentials: (CredentialView & { client_name: string; client_status: string })[];
  systemKeys: { label: string; secret_ref: string; platform: string; status: string; last_used_at: string | null }[];
}

export interface AgentStats { tasksToday: number; qaPass: number | null; qaReviews: number; costToday: number }
export interface RosterAgent {
  id: string;
  name: string;
  department: string;
  model_role: string;
  model_override: string | null;
  status: string;
  enabled: boolean;
  color: string;
  daily_budget_usd: number;
  stats: AgentStats;
}
export interface AgentTaskView { id: string; title: string; status: string; work_type: string; created_at: string; completed_at: string | null; cost_usd: number; client_name: string | null }
export interface AgentDetail { agent: RosterAgent; roleFile: { path: string; text: string } | null; tasks: AgentTaskView[] }

export type AccessLinkState = { state: 'open' | 'used' | 'expired' | 'invalid'; client_name?: string; platforms?: string[]; expires_at?: string; note?: string | null };

export interface Loaded<T> { data: T; error?: string }

// ---------- shared ----------
export const PLATFORMS = ['shopify', 'webflow', 'wordpress', 'github', 'figma', 'hosting', 'ftp', 'gmail', 'ga4', 'halaxy', 'other'] as const;

export const CRED_COLS = 'id,client_id,platform,label,login_url,username,secret_type,twofa_method,scope_notes,url_allowlist,write_allowlist,status,'
  + 'expires_at,last_used_at,last_used_by,failed_login_count,created_by,created_at,revoked_at';
const LINK_COLS = 'id,client_id,platforms,expires_at,used_at,created_at,note,credential_id,cancelled_at';
const CLIENT_COLS = 'id,name,slug,platforms,website,service_package,status,notes,rizehub_workspace_id,created_at';

/** Status as shown: DB status, plus "expiring" when the expiry date is within 14 days. */
export function displayStatus(c: Pick<CredentialView, 'status' | 'expires_at'>, now = Date.now()): CredentialStatus {
  if (c.status !== 'active' || !c.expires_at) return c.status;
  return new Date(c.expires_at).getTime() - now < 14 * 86400_000 ? 'expiring' : 'active';
}

function must<T>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return (res.data ?? []) as T;
}

async function liveDb(): Promise<SupabaseClient | null> {
  if (!supabaseEnv()) return null;
  return createSupabaseServer();
}

function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
/** Start of today in Asia/Manila (UTC+8, no DST). */
export function manilaDayStart(now = new Date()) {
  return new Date(`${now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })}T00:00:00+08:00`).toISOString();
}
const OPEN_REQ = new Set(['staged', 'planning', 'plan_review', 'in_progress', 'awaiting_ceo']);

async function withGrants(db: SupabaseClient, creds: Omit<CredentialView, 'grants'>[]): Promise<CredentialView[]> {
  if (!creds.length) return [];
  const g = must<{ credential_id: string; agent_id: string }[]>(
    await db.from('credential_grants').select('credential_id,agent_id').in('credential_id', creds.map((c) => c.id)), 'credential_grants');
  return creds.map((c) => ({ ...c, url_allowlist: c.url_allowlist ?? [], write_allowlist: c.write_allowlist ?? [], grants: g.filter((x) => x.credential_id === c.id).map((x) => x.agent_id).sort() }));
}

// ---------- clients ----------
export async function loadClientSummaries(): Promise<Loaded<ClientSummary[]>> {
  const db = await liveDb();
  if (!db) return { data: demoVault().summaries() };
  try {
    const [clients, reqs, creds, links] = await Promise.all([
      db.from('clients').select(CLIENT_COLS).order('name'),
      db.from('requests').select('client_id,status,cost_usd,created_at').not('client_id', 'is', null).gte('created_at', new Date(Date.now() - 120 * 86400_000).toISOString()),
      db.from('client_credentials').select('id,client_id,status,expires_at'),
      db.from('access_requests').select('client_id,expires_at,used_at,cancelled_at').is('used_at', null).is('cancelled_at', null),
    ]);
    const cl = must<VaultClient[]>(clients, 'clients');
    const rq = must<{ client_id: string; status: string; cost_usd: number | string; created_at: string }[]>(reqs, 'requests');
    const cr = must<{ client_id: string; status: CredentialStatus; expires_at: string | null }[]>(creds, 'client_credentials');
    const ln = must<{ client_id: string; expires_at: string }[]>(links, 'access_requests');
    const ms = monthStart();
    return {
      data: cl.map((c) => ({
        ...c, platforms: c.platforms ?? [],
        openRequests: rq.filter((r) => r.client_id === c.id && OPEN_REQ.has(r.status)).length,
        spendMonth: rq.filter((r) => r.client_id === c.id && r.created_at >= ms).reduce((s, r) => s + Number(r.cost_usd || 0), 0),
        credentials: cr.filter((x) => x.client_id === c.id && x.status !== 'revoked').length,
        attention: cr.filter((x) => x.client_id === c.id && ['check_needed', 'expiring'].includes(displayStatus(x))).length,
        openLinks: ln.filter((l) => l.client_id === c.id && new Date(l.expires_at).getTime() > Date.now()).length,
      })),
    };
  } catch (e) {
    return { data: [], error: e instanceof Error ? e.message : 'Could not load clients' };
  }
}

export async function loadClientDetail(id: string): Promise<Loaded<ClientDetail | null>> {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return { data: null };
  const db = await liveDb();
  if (!db) return { data: demoVault().detail(id) };
  try {
    const one = await db.from('clients').select(CLIENT_COLS).eq('id', id).maybeSingle();
    if (one.error) throw new Error(`client: ${one.error.message}`);
    const client = one.data as VaultClient | null;
    if (!client) return { data: null };
    const [creds, links, reqs] = await Promise.all([
      db.from('client_credentials').select(CRED_COLS).eq('client_id', id).order('created_at'),
      db.from('access_requests').select(LINK_COLS).eq('client_id', id).order('created_at', { ascending: false }).limit(20),
      db.from('requests').select('id,title,raw_text,status,priority,cost_usd,created_at,due_date').eq('client_id', id)
        .order('created_at', { ascending: false }).limit(50),
    ]);
    const credentials = await withGrants(db, must<Omit<CredentialView, 'grants'>[]>(creds, 'client_credentials'));
    const log = credentials.length ? must<AccessLogView[]>(await db.from('credential_access_log')
      .select('id,credential_id,agent_id,action,success,detail,created_at').in('credential_id', credentials.map((c) => c.id))
      .order('created_at', { ascending: false }).limit(150), 'credential_access_log') : [];
    return {
      data: {
        client: { ...client, platforms: client.platforms ?? [] }, credentials, log,
        links: must<AccessLinkView[]>(links, 'access_requests'),
        requests: must<ClientRequestView[]>(reqs, 'requests').map((r) => ({ ...r, cost_usd: Number(r.cost_usd || 0) })),
      },
    };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : 'Could not load the client' };
  }
}

// ---------- connections ----------
export async function loadConnections(): Promise<Loaded<ConnectionsData>> {
  const db = await liveDb();
  if (!db) return { data: demoVault().connections() };
  try {
    const [creds, clients, conns] = await Promise.all([
      db.from('client_credentials').select(CRED_COLS).order('created_at'),
      db.from('clients').select('id,name,status,platforms').order('name'),
      db.from('connections').select('label,secret_ref,platform,status,last_used_at').is('client_id', null),
    ]);
    const cl = must<{ id: string; name: string; status: string; platforms: string[] | null }[]>(clients, 'clients');
    const byId = new Map(cl.map((c) => [c.id, c]));
    const list = await withGrants(db, must<Omit<CredentialView, 'grants'>[]>(creds, 'client_credentials'));
    return {
      data: {
        clients: cl.map((c) => ({ ...c, platforms: c.platforms ?? [] })),
        credentials: list.map((c) => ({ ...c, client_name: byId.get(c.client_id)?.name ?? 'Unknown client', client_status: byId.get(c.client_id)?.status ?? 'active' })),
        systemKeys: must<ConnectionsData['systemKeys']>(conns, 'connections'),
      },
    };
  } catch (e) {
    return { data: { clients: [], credentials: [], systemKeys: [] }, error: e instanceof Error ? e.message : 'Could not load connections' };
  }
}

// ---------- agents ----------
interface AgentDbRow { id: string; name: string; department: string; model_role: string; model_override: string | null; status: string; enabled: boolean; avatar: { color?: string } | null; daily_budget_usd: number | string }

export async function loadRoster(): Promise<Loaded<RosterAgent[]>> {
  const db = await liveDb();
  if (!db) return { data: demoVault().roster() };
  try {
    const today = manilaDayStart();
    const week = new Date(Date.now() - 7 * 86400_000).toISOString();
    const [agents, tasks, qa, usage] = await Promise.all([
      db.from('agents').select('id,name,department,model_role,model_override,status,enabled,avatar,daily_budget_usd').order('department').order('name'),
      db.from('tasks').select('agent_id,status,started_at,completed_at').or(`started_at.gte.${today},completed_at.gte.${today}`),
      db.from('qa_reviews').select('verdict,tasks!inner(agent_id)').gte('created_at', week),
      db.from('activity_log').select('actor,cost_usd').like('action', 'usage.%').gte('created_at', today),
    ]);
    const tk = must<{ agent_id: string }[]>(tasks, 'tasks');
    const qr = must<{ verdict: string; tasks: { agent_id: string } | { agent_id: string }[] }[]>(qa, 'qa_reviews');
    const us = must<{ actor: string; cost_usd: number | string }[]>(usage, 'activity_log');
    return {
      data: must<AgentDbRow[]>(agents, 'agents').map((a) => {
        const mine = qr.filter((q) => (Array.isArray(q.tasks) ? q.tasks[0]?.agent_id : q.tasks?.agent_id) === a.id);
        const passed = mine.filter((q) => q.verdict === 'pass').length;
        return {
          id: a.id, name: a.name, department: a.department, model_role: a.model_role, model_override: a.model_override,
          status: a.status, enabled: a.enabled, color: a.avatar?.color ?? '#6D4AFF', daily_budget_usd: Number(a.daily_budget_usd || 0),
          stats: {
            tasksToday: tk.filter((t) => t.agent_id === a.id).length,
            qaReviews: mine.length, qaPass: mine.length ? Math.round((passed / mine.length) * 100) : null,
            costToday: us.filter((u) => u.actor === a.id).reduce((s, u) => s + Number(u.cost_usd || 0), 0),
          },
        };
      }),
    };
  } catch (e) {
    return { data: [], error: e instanceof Error ? e.message : 'Could not load agents' };
  }
}

/** agents/<id>.md from the repo (read-only). Looks in AGENTS_DIR, then up from the app directory. */
export function readRoleFile(id: string): { path: string; text: string } | null {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) return null;
  const dirs = [process.env.AGENTS_DIR, path.join(process.cwd(), 'agents'), path.join(process.cwd(), '../../agents'), path.join(process.cwd(), '../agents')]
    .filter((d): d is string => Boolean(d));
  for (const dir of dirs) {
    const file = path.join(dir, `${id}.md`);
    try {
      if (fs.statSync(file).isFile()) return { path: `agents/${id}.md`, text: fs.readFileSync(file, 'utf8').slice(0, 60_000) };
    } catch { /* next */ }
  }
  return null;
}

export async function loadAgentDetail(id: string): Promise<Loaded<AgentDetail | null>> {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) return { data: null };
  const roster = await loadRoster();
  const agent = roster.data.find((a) => a.id === id);
  if (!agent) return { data: null, error: roster.error };
  const roleFile = readRoleFile(id);
  const db = await liveDb();
  if (!db) return { data: { agent, roleFile, tasks: demoVault().agentTasks(id) } };
  try {
    const rows = must<(Omit<AgentTaskView, 'client_name' | 'cost_usd'> & { cost_usd: number | string; clients: { name: string } | { name: string }[] | null })[]>(
      await db.from('tasks').select('id,title,status,work_type,created_at,completed_at,cost_usd,clients(name)').eq('agent_id', id)
        .order('created_at', { ascending: false }).limit(15), 'tasks');
    return { data: { agent, roleFile, tasks: rows.map(({ clients, ...t }) => ({ ...t, cost_usd: Number(t.cost_usd || 0), client_name: (Array.isArray(clients) ? clients[0]?.name : clients?.name) ?? null })) } };
  } catch (e) {
    return { data: { agent, roleFile, tasks: [] }, error: e instanceof Error ? e.message : 'Could not load tasks' };
  }
}

// ---------- the client's secure link ----------
/** State of a one-time access link (public page). LIVE asks the worker (it holds the service role). */
export async function loadAccessLinkState(token: string): Promise<AccessLinkState> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return { state: 'invalid' };
  if (!supabaseEnv()) return demoVault().linkState(token);
  const worker = workerEnv();
  if (!worker) return { state: 'invalid' };
  try {
    const res = await fetch(`${worker.url}/vault/access/state`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hq-secret': worker.secret },
      body: JSON.stringify({ token }), cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { state: 'invalid' };
    return (await res.json()) as AccessLinkState;
  } catch {
    return { state: 'invalid' };
  }
}
