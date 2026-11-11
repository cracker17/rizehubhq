'use server';
// HQ Brain P2 member flow: /join/<code> (set a password → signed in) and 2FA enrolment for invited people. Members never
// get the CEO's actions; these check that the session belongs to an active brain person (brain_my_access).
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { callBrain } from '@/lib/brainCall';
import { friendlyMfaError, totpState, verifyTotp } from '@/lib/auth/mfaServer';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const CODE = /^[0-9a-f]{40}$/;
const FACTOR_ID = /^[0-9a-f-]{36}$/i;

/** Create the login from the invite, then sign in with it (the session cookie is set by the server client). */
export async function joinBrainAction(code: unknown, password: unknown): Promise<Result<{ email: string }>> {
  if (typeof code !== 'string' || !CODE.test(code)) return { ok: false, error: 'This invite link is not valid.' };
  if (typeof password !== 'string') return { ok: false, error: 'Choose a password.' };
  if (!supabaseEnv()) return { ok: false, error: 'Demo mode: joining needs the live HQ.' };
  const r = await callBrain<{ ok?: boolean; email?: string }>('/people/join', { method: 'POST', body: { code, password }, timeoutMs: 20_000 });
  if (r.status !== 200 || !r.body.email) return { ok: false, error: r.body.error ?? 'Could not create your login. Try again in a minute.' };
  const db = await createSupabaseServer();
  if (!db) return { ok: false, error: 'HQ sign-in is not configured.' };
  const { error } = await db.auth.signInWithPassword({ email: r.body.email, password });
  if (error) return { ok: false, error: 'Your login was created, but signing in failed. Sign in at /login with your e-mail and new password.' };
  return { ok: true, email: r.body.email };
}

type Db = NonNullable<Awaited<ReturnType<typeof createSupabaseServer>>>;

async function requirePerson(): Promise<{ db: Db } | { error: string }> {
  if (!supabaseEnv()) return { error: 'Demo mode: 2FA needs the live HQ.' };
  const db = await createSupabaseServer();
  if (!db) return { error: 'HQ sign-in is not configured.' };
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };
  const { data } = await db.rpc('brain_my_access');
  if (!data) return { error: 'This account has no HQ Brain access.' };
  return { db };
}

export async function memberStartTotpAction(): Promise<Result<{ factorId: string; qr: string; secret: string }>> {
  const p = await requirePerson();
  if ('error' in p) return { ok: false, error: p.error };
  const state = await totpState(p.db);
  if (!state) return { ok: false, error: 'Your session expired. Sign in again.' };
  if (state.factorId) return { ok: false, error: '2FA is already on for this account.' };
  for (const id of state.unverifiedIds) await p.db.auth.mfa.unenroll({ factorId: id }).catch(() => undefined);
  const { data, error } = await p.db.auth.mfa.enroll({ factorType: 'totp', issuer: 'RizeHub HQ Brain', friendlyName: `HQ Brain ${new Date().toISOString().slice(0, 10)}` });
  if (error || !data) return { ok: false, error: friendlyMfaError(error?.message ?? 'Could not start 2FA setup.') };
  return { ok: true, factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}

export async function memberConfirmTotpAction(factorId: unknown, code: unknown): Promise<Result> {
  if (typeof factorId !== 'string' || !FACTOR_ID.test(factorId)) return { ok: false, error: 'Start the setup again.' };
  const p = await requirePerson();
  if ('error' in p) return { ok: false, error: p.error };
  return verifyTotp(p.db, factorId, code);
}

export async function memberSignOutAction(): Promise<void> {
  const db = await createSupabaseServer();
  await db?.auth.signOut().catch(() => undefined);
}
