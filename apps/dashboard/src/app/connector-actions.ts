'use server';
// Admin → Connectors actions (docs/15). The CEO check happens here; secrets only travel browser → this action →
// worker (/connectors/*), which tests them against Google, seals and stores them. Nothing here stores or logs them.
// Adding an account, giving more agents access, allowing drafts and re-enabling need a fresh 2FA code (the SQL functions
// enforce it too); the UI retries with the code when an action answers { stepUp: true }.
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { ensureStepUp } from '@/lib/auth/mfaServer';
import { isStepUpError } from '@/lib/auth/stepUp';
import { callWorker } from '@/lib/workerCall';

export type ConnectorResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; stepUp?: boolean };
type Db = NonNullable<Awaited<ReturnType<typeof createSupabaseServer>>>;

const ID = /^[0-9a-f-]{36}$/i;
const AGENT = /^[a-z0-9-]{1,64}$/;
const DEMO = 'Demo mode: connecting accounts needs the live dashboard.';

async function requireCeo(): Promise<{ demo: true } | { demo: false; db: Db } | { error: string }> {
  if (!supabaseEnv()) return { demo: true };
  const db = await createSupabaseServer();
  if (!db) return { error: 'Supabase is not configured.' };
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };
  const ceo = await db.from('ceo_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!ceo.data) return { error: 'This account is not the CEO.' };
  return { demo: false, db };
}

function friendly(message: string): string {
  if (isStepUpError(message)) return 'Confirm with a fresh 2FA code.';
  if (/not allowed|permission denied|42501/i.test(message)) return 'This account is not allowed to do that (not the CEO).';
  if (/JWT|session/i.test(message)) return 'Your session expired. Sign in again.';
  return message.replace(/^connector_\w+: /, '');
}

const agentsOf = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map(String).filter((a) => AGENT.test(a)))].slice(0, 10);

/** A fresh code is always needed to add an account (it hands agents a mailbox). */
async function stepUpIfEnrolled(db: Db, totp: unknown) {
  return ensureStepUp(db, (s) => (s.factorId ? 'required' : 'not_needed'), totp);
}

/** Runs an RPC; a code given up front is verified first, a missing one comes back as { stepUp: true }. */
async function rpcWithStepUp(db: Db, fn: string, args: Record<string, unknown>, totp: unknown): Promise<ConnectorResult> {
  if (totp) {
    const step = await stepUpIfEnrolled(db, totp);
    if (!step.ok) return step;
  }
  const r = await db.rpc(fn, args);
  if (r.error) return { ok: false, error: friendly(r.error.message), stepUp: isStepUpError(r.error.message) || undefined };
  return { ok: true };
}

type Mode = 'read' | 'read_draft' | 'read_draft_send';
const modeOf = (m: unknown): Mode => (m === 'read_draft' || m === 'read_draft_send' ? m : 'read');

export async function addGmailAction(input: { email: string; appPassword: string; name?: string; agents: string[]; mode: Mode; totp?: string | null }): Promise<ConnectorResult<{ id: string }>> {
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  const step = await stepUpIfEnrolled(ceo.db, input.totp);
  if (!step.ok) return step;
  const r = await callWorker<{ id: string }>('/connectors/gmail/add', {
    email: String(input.email ?? '').trim(), appPassword: String(input.appPassword ?? ''), name: String(input.name ?? '').trim() || undefined,
    agents: agentsOf(input.agents), mode: modeOf(input.mode),
  });
  if (r.status !== 200 || !('id' in r.body)) return { ok: false, error: r.body.error ?? 'Could not add the account.' };
  return { ok: true, id: r.body.id };
}

export async function replaceGmailPasswordAction(input: { id: string; appPassword: string; totp?: string | null }): Promise<ConnectorResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown account.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  const step = await stepUpIfEnrolled(ceo.db, input.totp);
  if (!step.ok) return step;
  const r = await callWorker<{ ok: boolean }>('/connectors/gmail/replace', { id: input.id, appPassword: String(input.appPassword ?? '') });
  return r.status === 200 ? { ok: true } : { ok: false, error: r.body.error ?? 'Could not replace the App Password.' };
}

export async function testConnectorAction(input: { id: string }): Promise<ConnectorResult<{ working: boolean; message: string }>> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown account.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: true, working: true, message: 'Demo mode: pretending the login works.' };
  const r = await callWorker<{ ok: boolean; error?: string; message?: string }>('/connectors/test', { id: input.id }, 45_000);
  if (r.status !== 200) return { ok: false, error: r.body.error ?? 'Test failed.' };
  return {
    ok: true, working: Boolean(r.body.ok),
    message: r.body.ok ? (r.body.message ?? 'Signed in to Gmail successfully.') : (r.body.error ?? 'Gmail refused the login.'),
  };
}

// ---------- Calendars (Google Calendar secret iCal address, read-only) ----------
/**
 * The secret address is a credential (anyone holding it can read the calendar): it goes browser → here → worker, which
 * test-reads it, seals it and stores it. It is never stored in a readable column, logged or sent back.
 */
export async function addCalendarAction(input: { url: string; name?: string; agents: string[]; totp?: string | null }): Promise<ConnectorResult<{ id: string; name: string; events: number }>> {
  const url = String(input.url ?? '').trim();
  if (!url) return { ok: false, error: 'Paste the calendar’s secret address.' };
  if (url.length > 2000) return { ok: false, error: 'That address is too long.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  const step = await stepUpIfEnrolled(ceo.db, input.totp);
  if (!step.ok) return step;
  const r = await callWorker<{ id: string; name: string; events: number }>('/connectors/ical/add', {
    url, name: String(input.name ?? '').trim().slice(0, 120) || undefined, agents: agentsOf(input.agents),
  }, 45_000);
  if (r.status !== 200 || !('id' in r.body)) return { ok: false, error: r.body.error ?? 'Could not add the calendar.' };
  return { ok: true, id: r.body.id, name: r.body.name, events: r.body.events };
}

export async function setConnectorAgentsAction(input: { id: string; agents: string[]; totp?: string | null }): Promise<ConnectorResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown account.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  return rpcWithStepUp(ceo.db, 'connector_set_grants', { p_id: input.id, p_agents: agentsOf(input.agents) }, input.totp);
}

export async function updateConnectorAction(input: { id: string; name: string; mode: Mode; totp?: string | null }): Promise<ConnectorResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown account.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  return rpcWithStepUp(ceo.db, 'connector_update', {
    p_id: input.id, p_name: String(input.name ?? '').slice(0, 120), p_settings: { mode: modeOf(input.mode) },
  }, input.totp);
}

export async function setConnectorStatusAction(input: { id: string; status: 'active' | 'disabled'; totp?: string | null }): Promise<ConnectorResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown account.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  return rpcWithStepUp(ceo.db, 'connector_set_status', { p_id: input.id, p_status: input.status === 'active' ? 'active' : 'disabled' }, input.totp);
}

export async function deleteConnectorAction(input: { id: string }): Promise<ConnectorResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown account.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  const r = await ceo.db.rpc('connector_delete', { p_id: input.id });
  return r.error ? { ok: false, error: friendly(r.error.message) } : { ok: true };
}

// ---------- Apps (MCP) ----------
export interface AppTarget { catalogKey?: string; url?: string; name?: string; agents: string[]; projectRef?: string }

function cleanTarget(t: AppTarget) {
  return {
    catalogKey: t.catalogKey || undefined, url: t.url?.trim() || undefined, name: t.name?.trim() || undefined,
    agents: agentsOf(t.agents), projectRef: t.projectRef?.trim() || undefined,
  };
}

/** Sign in to an app: returns the vendor's consent URL (the browser goes there) or, rarely, a finished connection. */
export async function startAppSignInAction(input: AppTarget & { own?: { clientId: string; clientSecret?: string }; totp?: string | null }): Promise<ConnectorResult<{ authorizeUrl?: string; id?: string }>> {
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  const step = await stepUpIfEnrolled(ceo.db, input.totp);
  if (!step.ok) return step;
  const own = input.own?.clientId?.trim() ? { clientId: input.own.clientId.trim(), clientSecret: input.own.clientSecret?.trim() || undefined } : undefined;
  const r = await callWorker<{ authorizeUrl?: string; id?: string }>('/connectors/mcp/start', { ...cleanTarget(input), own }, 45_000);
  if (r.status !== 200) return { ok: false, error: r.body.error ?? 'Could not start the sign-in.' };
  const authorizeUrl = r.body.authorizeUrl;
  if (authorizeUrl && !/^https:\/\//i.test(authorizeUrl)) return { ok: false, error: 'The app returned an unsafe sign-in link.' };
  return { ok: true, authorizeUrl, id: r.body.id };
}

export async function connectAppTokenAction(input: AppTarget & { token: string; header?: string; totp?: string | null }): Promise<ConnectorResult<{ id: string; tools: number }>> {
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  const step = await stepUpIfEnrolled(ceo.db, input.totp);
  if (!step.ok) return step;
  const r = await callWorker<{ id: string; tools: number }>('/connectors/mcp/token', { ...cleanTarget(input), token: String(input.token ?? ''), header: input.header?.trim() || undefined }, 45_000);
  if (r.status !== 200 || !('id' in r.body)) return { ok: false, error: r.body.error ?? 'Could not connect.' };
  return { ok: true, id: r.body.id, tools: r.body.tools };
}

export async function syncAppAction(input: { id: string }): Promise<ConnectorResult<{ working: boolean; message: string }>> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown app.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: true, working: true, message: 'Demo mode: pretending the app answered.' };
  const r = await callWorker<{ ok: boolean; tools?: number; error?: string }>('/connectors/mcp/sync', { id: input.id }, 45_000);
  if (r.status !== 200) return { ok: false, error: r.body.error ?? 'Refresh failed.' };
  return { ok: true, working: Boolean(r.body.ok), message: r.body.ok ? `Connected: ${r.body.tools ?? 0} tools. New or changed tools wait for your review.` : (r.body.error ?? 'The app did not answer.') };
}

export async function setToolPoliciesAction(input: { id: string; policies: Record<string, 'allow' | 'ask' | 'off'>; totp?: string | null }): Promise<ConnectorResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown app.' };
  const policies = Object.fromEntries(Object.entries(input.policies ?? {})
    .filter(([k, v]) => k.length <= 128 && (v === 'allow' || v === 'ask' || v === 'off')).slice(0, 300));
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  return rpcWithStepUp(ceo.db, 'connector_set_tool_policies', { p_id: input.id, p_policies: policies }, input.totp);
}

// ---------- Storage (Google Drive / Dropbox, docs/15 §6) ----------
type StorageProviderKey = 'drive' | 'dropbox';

/** Sign in with the CEO's own OAuth app: returns the vendor's consent URL (the browser goes there). */
export async function startStorageSignInAction(input: {
  provider: StorageProviderKey; clientId: string; clientSecret: string; name?: string; appFolder?: string; totp?: string | null;
}): Promise<ConnectorResult<{ authorizeUrl: string }>> {
  const provider = input.provider === 'dropbox' ? 'dropbox' : input.provider === 'drive' ? 'drive' : null;
  if (!provider) return { ok: false, error: 'Pick Google Drive or Dropbox.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  // Connecting storage hands HQ a place to write files: same fresh 2FA code as adding a Gmail account.
  const step = await stepUpIfEnrolled(ceo.db, input.totp);
  if (!step.ok) return step;
  const r = await callWorker<{ authorizeUrl: string }>('/connectors/storage/start', {
    provider, clientId: String(input.clientId ?? '').trim(), clientSecret: String(input.clientSecret ?? '').trim(),
    name: String(input.name ?? '').trim() || undefined, appFolder: String(input.appFolder ?? '').trim() || undefined,
  });
  if (r.status !== 200 || !('authorizeUrl' in r.body)) return { ok: false, error: r.body.error ?? 'Could not start the sign-in.' };
  const url = r.body.authorizeUrl;
  const host = /^https:\/\/([^/]+)\//i.exec(url)?.[1]?.toLowerCase();
  if (host !== 'accounts.google.com' && host !== 'www.dropbox.com') return { ok: false, error: 'The worker returned an unexpected sign-in link.' };
  return { ok: true, authorizeUrl: url };
}

export async function setDefaultStorageAction(input: { id: string }): Promise<ConnectorResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown storage.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: DEMO };
  const r = await ceo.db.rpc('storage_set_default', { p_connector: input.id });
  return r.error ? { ok: false, error: friendly(r.error.message).replace(/^storage_set_default: /, '') } : { ok: true };
}

export async function testStorageAction(input: { id: string }): Promise<ConnectorResult<{ working: boolean; message: string }>> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown storage.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: true, working: true, message: 'Demo mode: pretending the storage answered.' };
  const r = await callWorker<{ ok: boolean; account?: string | null; error?: string }>('/connectors/storage/test', { id: input.id }, 45_000);
  if (r.status !== 200) return { ok: false, error: r.body.error ?? 'Test failed.' };
  return {
    ok: true, working: Boolean(r.body.ok),
    message: r.body.ok ? `Connected${r.body.account ? ` as ${r.body.account}` : ''}. HQ can save files.` : (r.body.error ?? 'The storage did not answer.'),
  };
}
