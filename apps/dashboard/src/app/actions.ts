'use server';
// Server actions. The dashboard changes state ONLY through the workflow RPCs
// create_request and decide_approval (supabase/migrations/20260928010000_workflow_engine.sql),
// always as the signed-in user so RLS / hq_guard() apply. No service-role key here.
import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase/server';
import { loadLiveSnapshot } from '@/lib/data/loaders';
import { workerEnv } from '@/lib/env';
import type { Decision, HqSnapshot, Priority } from '@/lib/data/types';

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];
const DECISIONS: Decision[] = ['approve', 'changes', 'reject'];

function friendly(message: string): string {
  if (/not allowed|permission denied|42501/i.test(message)) return 'This account is not allowed to do that (not the CEO).';
  if (/JWT|session/i.test(message)) return 'Your session expired. Sign in again.';
  return message;
}

async function liveClient() {
  const db = await createSupabaseServer();
  if (!db) return { db: null, error: 'Demo mode: no database configured.' } as const;
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { db: null, error: 'Your session expired. Sign in again.' } as const;
  return { db, error: null } as const;
}

export async function createRequestAction(input: {
  text: string; priority: Priority; dueDate: string | null; clientSlug: string | null;
}): Promise<ActionResult<{ id: string }>> {
  const text = String(input.text ?? '').trim();
  if (!text) return { ok: false, error: 'Tell the team what you need first.' };
  if (text.length > 8000) return { ok: false, error: 'That request is too long (max 8,000 characters).' };
  const priority = PRIORITIES.includes(input.priority) ? input.priority : 'normal';
  const dueDate = input.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ? input.dueDate : null;
  const clientSlug = input.clientSlug && /^[a-z0-9-]{1,80}$/.test(input.clientSlug) ? input.clientSlug : null;

  const { db, error } = await liveClient();
  if (!db) return { ok: false, error };
  const res = await db.rpc('create_request', {
    p_source: 'dashboard', p_raw_text: text, p_priority: priority, p_due_date: dueDate, p_client_slug: clientSlug,
  });
  if (res.error) return { ok: false, error: friendly(res.error.message) };
  return { ok: true, id: String(res.data) };
}

export async function decideApprovalAction(input: { id: string; decision: Decision; note: string | null }): Promise<ActionResult<{ result: string }>> {
  if (!DECISIONS.includes(input.decision)) return { ok: false, error: 'Unknown decision.' };
  const note = input.note?.trim() ? input.note.trim().slice(0, 4000) : null;
  if (input.decision === 'changes' && !note) return { ok: false, error: 'Say what should change.' };
  if (!/^[0-9a-f-]{36}$/i.test(input.id)) return { ok: false, error: 'Unknown approval.' };

  const { db, error } = await liveClient();
  if (!db) return { ok: false, error };
  const res = await db.rpc('decide_approval', { p_approval: input.id, p_decision: input.decision, p_note: note, p_via: 'dashboard' });
  if (res.error) return { ok: false, error: friendly(res.error.message) };
  const result = String(res.data ?? '');
  if (result.startsWith('already_')) return { ok: false, error: `Already decided (${result.replace('already_', '').replace('_', ' ')}), probably from Telegram.` };
  return { ok: true, result };
}

/** Full reload of the store (after reconnects or when realtime is unavailable). */
export async function refreshSnapshotAction(): Promise<HqSnapshot | null> {
  const { db } = await liveClient();
  if (!db) return null;
  try { return await loadLiveSnapshot(db); } catch { return null; }
}

/**
 * Agent chat: proxies to the worker's /chat endpoint with the internal secret (server-side only).
 * Requires a signed-in LIVE session so the secret-bearing call can't be triggered anonymously.
 * Returns { live: false } when not configured, and the client shows the demo reply.
 */
export async function askAgentAction(input: { agentId: string; question: string }): Promise<ActionResult<{ answer: string | null; live: boolean }>> {
  const question = String(input.question ?? '').trim().slice(0, 2000);
  if (!question) return { ok: false, error: 'Ask something first.' };
  if (!/^[a-z0-9-]{1,64}$/.test(input.agentId)) return { ok: false, error: 'Unknown agent.' };
  const worker = workerEnv();
  if (!worker) return { ok: true, answer: null, live: false };
  const { db } = await liveClient();
  if (!db) return { ok: true, answer: null, live: false };
  // Only the CEO may talk to agents (the worker trusts the shared secret, so check here).
  const { data: { user } } = await db.auth.getUser();
  const ceo = user ? await db.from('ceo_users').select('user_id').eq('user_id', user.id).maybeSingle() : null;
  if (!ceo?.data) return { ok: false, error: 'This account is not the CEO.' };

  try {
    const res = await fetch(`${worker.url}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hq-secret': worker.secret },
      body: JSON.stringify({ agentId: input.agentId, question }),
      signal: AbortSignal.timeout(45_000),
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, error: `The worker answered ${res.status}. Is it running?` };
    const body = (await res.json().catch(() => ({}))) as { answer?: string; reply?: string; text?: string };
    const answer = body.answer ?? body.reply ?? body.text;
    if (!answer) return { ok: false, error: 'The worker sent an empty answer.' };
    return { ok: true, answer, live: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === 'TimeoutError' ? 'The agent took too long to answer.' : 'Could not reach the worker.' };
  }
}

// ---------- auth (LIVE only) ----------
export async function signInAction(_prev: { error: string | null }, form: FormData): Promise<{ error: string | null }> {
  const db = await createSupabaseServer();
  if (!db) redirect('/');
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!email || !password) return { error: 'Enter your email and password.' };
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) return { error: /invalid/i.test(error.message) ? 'Wrong email or password.' : error.message };
  // TODO(2FA): require TOTP via Supabase MFA before continuing — see apps/dashboard/README.md "Two-factor (TODO)".
  const next = String(form.get('next') ?? '/');
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

export async function signOutAction() {
  const db = await createSupabaseServer();
  if (db) await db.auth.signOut();
  redirect(db ? '/login' : '/');
}
