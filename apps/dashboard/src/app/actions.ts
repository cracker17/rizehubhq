'use server';
// Server actions. The dashboard changes state ONLY through the workflow RPCs
// create_request and decide_approval (supabase/migrations/20260928010000_workflow_engine.sql),
// always as the signed-in user so RLS / hq_guard() apply. No service-role key here.
import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase/server';
import { loadLiveSnapshot } from '@/lib/data/loaders';
import { workerEnv } from '@/lib/env';
import { approvalRisk, isStepUpError, needsTotpAtSignIn, safeNext, stepUpNeed } from '@/lib/auth/stepUp';
import { ensureStepUp, totpState, verifyTotp } from '@/lib/auth/mfaServer';
import { passwordProblem, recoveryFresh } from '@/lib/auth/password';
import { rateLimited, type Tries } from '@/lib/auth/rateLimit';
import { clientIp, dashboardOrigin } from '@/lib/auth/reauth';
import type { AmrClaim } from '@/lib/auth/stepUp';
import type { Decision, HqSnapshot, Priority } from '@/lib/data/types';

/** `stepUp: true` = retry with a fresh 2FA code (the UI opens the code dialog). */
export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; stepUp?: boolean };

const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];
const DECISIONS: Decision[] = ['approve', 'changes', 'reject'];

function friendly(message: string): string {
  if (isStepUpError(message)) return 'Confirm with a fresh 2FA code.';
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

/**
 * CEO decision. Approving a HIGH-RISK external action (approvalRisk) needs a fresh TOTP step-up once 2FA is set up:
 * without `totp` the result is { ok: false, stepUp: true } and the UI asks for the code; with it the code is verified
 * (session → aal2 + fresh amr) right before decide_approval, which checks the same thing in the database.
 */
export async function decideApprovalAction(input: { id: string; decision: Decision; note: string | null; totp?: string | null }): Promise<ActionResult<{ result: string }>> {
  if (!DECISIONS.includes(input.decision)) return { ok: false, error: 'Unknown decision.' };
  const note = input.note?.trim() ? input.note.trim().slice(0, 4000) : null;
  if (input.decision === 'changes' && !note) return { ok: false, error: 'Say what should change.' };
  if (!/^[0-9a-f-]{36}$/i.test(input.id)) return { ok: false, error: 'Unknown approval.' };

  const { db, error } = await liveClient();
  if (!db) return { ok: false, error };
  if (input.decision === 'approve') {
    const ap = await db.from('approvals').select('kind,payload').eq('id', input.id).maybeSingle();
    if (ap.error) return { ok: false, error: friendly(ap.error.message) };
    // No row = not visible to this session (not the CEO / unknown id): decide_approval gives the precise error.
    if (ap.data) {
      const risk = approvalRisk(ap.data as { kind: string; payload: Record<string, unknown> });
      const step = await ensureStepUp(db, (s) => stepUpNeed({
        decision: input.decision, risk, enrolled: s.factorId !== null, totpAt: s.totpAt, nowSec: Math.floor(Date.now() / 1000),
      }), input.totp);
      if (!step.ok) return step;
    }
  }
  const res = await db.rpc('decide_approval', { p_approval: input.id, p_decision: input.decision, p_note: note, p_via: 'dashboard' });
  if (res.error) return { ok: false, error: friendly(res.error.message), stepUp: isStepUpError(res.error.message) || undefined };
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
  const next = safeNext(form.get('next'));
  // 2FA: with a verified TOTP factor the password alone gives an aal1 session; the TOTP step upgrades it to aal2.
  const state = await totpState(db);
  if (state && needsTotpAtSignIn({ currentLevel: state.currentLevel, hasVerifiedFactor: state.factorId !== null })) {
    redirect(`/login?step=totp&next=${encodeURIComponent(next)}`);
  }
  redirect(next);
}

/** Second sign-in step: the 6-digit code from the authenticator app. */
export async function verifySignInTotpAction(_prev: { error: string | null }, form: FormData): Promise<{ error: string | null }> {
  const db = await createSupabaseServer();
  if (!db) redirect('/');
  const state = await totpState(db);
  if (!state) redirect('/login');
  const next = safeNext(form.get('next'));
  if (!state.factorId) redirect(next);
  const v = await verifyTotp(db, state.factorId, form.get('code'));
  if (!v.ok) return { error: v.error };
  redirect(next);
}

export async function signOutAction() {
  const db = await createSupabaseServer();
  if (db) await db.auth.signOut();
  redirect(db ? '/login' : '/');
}

// ---------- forgotten password (LIVE only; docs/09 "CEO password") ----------
const resetTries: Tries = new Map();
export interface ResetRequestState { sent: boolean; error: string | null }

/**
 * Emails a reset link (Supabase Auth). The answer never says whether the address has an account. The link lands on
 * /auth/confirm, which signs in with a 'recovery' session and forwards to /reset-password (2FA step first when on).
 */
export async function requestPasswordResetAction(_prev: ResetRequestState, form: FormData): Promise<ResetRequestState> {
  const db = await createSupabaseServer();
  if (!db) redirect('/');
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { sent: false, error: 'Enter the email you sign in with.' };
  const ip = await clientIp();
  if (rateLimited(resetTries, ip, 3, 15 * 60_000) || rateLimited(resetTries, '*', 20, 15 * 60_000)) {
    return { sent: false, error: 'Too many reset requests. Try again in 15 minutes.' };
  }
  const origin = await dashboardOrigin();
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/confirm?next=/reset-password` });
  // Logged without the address; the answer stays the same either way.
  if (error) console.error('[auth] password reset email failed:', error.message);
  return { sent: true, error: null };
}

/** Sets a new password from a fresh reset-link session (no current password: that is what was forgotten). */
export async function setRecoveredPasswordAction(_prev: { error: string | null }, form: FormData): Promise<{ error: string | null }> {
  const db = await createSupabaseServer();
  if (!db) redirect('/');
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect('/login');
  const { data: aal } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
  if (!recoveryFresh((aal?.currentAuthenticationMethods ?? []) as AmrClaim, Math.floor(Date.now() / 1000))) {
    return { error: 'This reset link has expired. Ask for a new one from the sign-in page.' };
  }
  const next = String(form.get('password') ?? '');
  const problem = passwordProblem(next, { email: user.email });
  if (problem) return { error: problem };
  if (next !== String(form.get('again') ?? '')) return { error: 'The two passwords don’t match.' };
  const { error } = await db.auth.updateUser({ password: next });
  if (error) return { error: /same.?password|should be different/i.test(error.message) ? 'That is already your password. Just sign in.' : error.message };
  await db.auth.signOut({ scope: 'others' }).catch(() => undefined);
  await db.from('activity_log').insert({ actor: 'ceo', action: 'security.password_reset', detail: { via: 'email_link' } }).then(() => undefined, () => undefined);
  redirect('/admin/security');
}
