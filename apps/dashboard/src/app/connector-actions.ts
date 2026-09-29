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
  const r = await callWorker<{ ok: boolean; error?: string }>('/connectors/test', { id: input.id });
  if (r.status !== 200) return { ok: false, error: r.body.error ?? 'Test failed.' };
  return { ok: true, working: Boolean(r.body.ok), message: r.body.ok ? 'Signed in to Gmail successfully.' : (r.body.error ?? 'Gmail refused the login.') };
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
