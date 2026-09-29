'use server';
// Admin → Security (TOTP 2FA, CEO password) and Settings → Auto-approve rules (docs/06 §10–11, docs/09, docs/05 [3]).
// * Enrollment uses Supabase Auth MFA as the signed-in CEO: enroll → show QR + secret ONCE (never stored or logged
//   here) → verify a code → the factor is verified and the session becomes aal2.
// * Changing the password or turning 2FA off needs the current password AND (with 2FA on) a fresh code; both sign out
//   every other session / are written to activity_log. Passwords and codes are never stored or logged.
// * Rules are saved through save_auto_approve_rule / delete_auto_approve_rule (validation, audit, step-up in SQL).
//   Turning a rule on needs a fresh 2FA code (it loosens the approval gate).
// DEMO mode keeps rules in memory and fakes enrollment (no real secret).
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { AutoApproveRuleInput, type AutoApproveRule } from '@rizehubhq/shared';
import { ensureStepUp, friendlyMfaError, totpState, verifyTotp } from '@/lib/auth/mfaServer';
import { isStepUpError, ruleSaveNeed } from '@/lib/auth/stepUp';
import { passwordProblem } from '@/lib/auth/password';
import { passwordMatches } from '@/lib/auth/reauth';
import { rateLimited, type Tries } from '@/lib/auth/rateLimit';
import { demoRules } from '@/lib/data/autoApproveDemo';

export type SecurityResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; stepUp?: boolean };

type Db = NonNullable<Awaited<ReturnType<typeof createSupabaseServer>>>;
type Ceo = { demo: true } | { demo: false; db: Db; userId: string; email: string | null };

async function requireCeo(): Promise<Ceo | { error: string }> {
  if (!supabaseEnv()) return { demo: true };
  const db = await createSupabaseServer();
  if (!db) return { error: 'Supabase is not configured.' };
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };
  const ceo = await db.from('ceo_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!ceo.data) return { error: 'This account is not the CEO.' };
  return { demo: false, db, userId: user.id, email: user.email ?? null };
}

function friendly(message: string): string {
  if (isStepUpError(message)) return 'Confirm with a fresh 2FA code.';
  if (/not allowed|permission denied|42501/i.test(message)) return 'This account is not allowed to do that (not the CEO).';
  if (/JWT|session/i.test(message)) return 'Your session expired. Sign in again.';
  if (/violates check constraint/i.test(message)) return 'Some values are out of range.';
  return message;
}

const FACTOR_ID = /^[0-9a-f-]{36}$/i;

// ---------- TOTP enrollment ----------
export async function startTotpEnrollAction(): Promise<SecurityResult<{ factorId: string; qr: string; secret: string }>> {
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: 'Demo mode: 2FA needs a real Supabase project.' };
  const state = await totpState(ceo.db);
  if (!state) return { ok: false, error: 'Your session expired. Sign in again.' };
  if (state.factorId) return { ok: false, error: '2FA is already on for this account.' };
  // Drop half-finished enrollments so the new QR is the only one.
  for (const id of state.unverifiedIds) await ceo.db.auth.mfa.unenroll({ factorId: id }).catch(() => undefined);
  const { data, error } = await ceo.db.auth.mfa.enroll({ factorType: 'totp', issuer: 'RizeHub HQ', friendlyName: `RizeHub HQ ${new Date().toISOString().slice(0, 10)}` });
  if (error || !data) return { ok: false, error: friendlyMfaError(error?.message ?? 'Could not start 2FA setup.') };
  return { ok: true, factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}

export async function confirmTotpEnrollAction(input: { factorId: string; code: string }): Promise<SecurityResult> {
  if (!FACTOR_ID.test(String(input.factorId ?? ''))) return { ok: false, error: 'Start the setup again.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: 'Demo mode: 2FA needs a real Supabase project.' };
  return verifyTotp(ceo.db, input.factorId, input.code);
}

export async function cancelTotpEnrollAction(input: { factorId: string }): Promise<SecurityResult> {
  if (!FACTOR_ID.test(String(input.factorId ?? ''))) return { ok: true };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: true };
  const state = await totpState(ceo.db);
  // Only an unfinished enrollment can be cancelled here (removing a verified factor = admin recovery, docs/09).
  if (!state?.unverifiedIds.includes(input.factorId)) return { ok: true };
  const { error } = await ceo.db.auth.mfa.unenroll({ factorId: input.factorId });
  return error ? { ok: false, error: error.message } : { ok: true };
}

// ---------- 2FA off / CEO password ----------
const passwordTries: Tries = new Map();

/** Audit row for a security change (never contains the password or code). */
async function audit(db: Db, action: string) {
  await db.from('activity_log').insert({ actor: 'ceo', action, detail: { via: 'dashboard' } }).then(() => undefined, () => undefined);
}

/** Current password + (2FA on) a fresh code, rate-limited: shared by the password change and turning 2FA off. */
async function confirmIdentity(ceo: Extract<Ceo, { demo: false }>, password: unknown, totp: unknown): Promise<SecurityResult> {
  const pw = typeof password === 'string' ? password : '';
  if (!pw) return { ok: false, error: 'Enter your current password.' };
  const step = await ensureStepUp(ceo.db, (s) => (s.factorId ? 'required' : 'not_needed'), totp);
  if (!step.ok) return step;
  if (rateLimited(passwordTries, ceo.userId, 5, 10 * 60_000)) return { ok: false, error: 'Too many attempts. Wait 10 minutes.' };
  if (!ceo.email) return { ok: false, error: 'Your account has no email to check the password with.' };
  if (!(await passwordMatches(ceo.email, pw, ceo.userId))) return { ok: false, error: 'Your current password is wrong.' };
  return { ok: true };
}

function friendlyPassword(message: string): string {
  if (/same.?password|should be different/i.test(message)) return 'That is already your password.';
  if (/weak|pwned|compromised/i.test(message)) return `Supabase rejected it as too weak: ${message}`;
  if (/reauthenticat/i.test(message)) return 'Supabase wants a recent sign-in for this. Sign out, sign in again and retry right away.';
  if (/aal|assurance/i.test(message)) return 'Sign in again with your 2FA code, then retry.';
  return friendly(message);
}

export async function changePasswordAction(input: { current: string; next: string; totp?: string | null }): Promise<SecurityResult> {
  const next = typeof input.next === 'string' ? input.next : '';
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: 'Demo mode: there is no account password to change.' };
  const problem = passwordProblem(next, { current: typeof input.current === 'string' ? input.current : null, email: ceo.email });
  if (problem) return { ok: false, error: problem };
  const who = await confirmIdentity(ceo, input.current, input.totp);
  if (!who.ok) return who;
  const { error } = await ceo.db.auth.updateUser({ password: next });
  if (error) return { ok: false, error: friendlyPassword(error.message) };
  await ceo.db.auth.signOut({ scope: 'others' }).catch(() => undefined);
  await audit(ceo.db, 'security.password_changed');
  return { ok: true };
}

/** Turn 2FA off (e.g. to move it to a new phone): current password + a code from the current app. */
export async function disableTotpAction(input: { password: string; totp?: string | null }): Promise<SecurityResult> {
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: false, error: 'Demo mode: 2FA needs a real Supabase project.' };
  const state = await totpState(ceo.db);
  if (!state) return { ok: false, error: 'Your session expired. Sign in again.' };
  if (!state.factorId) return { ok: true };
  const who = await confirmIdentity(ceo, input.password, input.totp);
  if (!who.ok) return who;
  const { error } = await ceo.db.auth.mfa.unenroll({ factorId: state.factorId });
  if (error) return { ok: false, error: friendlyMfaError(error.message) };
  await ceo.db.auth.signOut({ scope: 'others' }).catch(() => undefined);
  await audit(ceo.db, 'security.2fa_disabled');
  return { ok: true };
}

// ---------- auto-approve rules ----------
export async function saveAutoApproveRuleAction(input: unknown, totp?: string | null): Promise<SecurityResult<{ rules: AutoApproveRule[] }>> {
  const parsed = AutoApproveRuleInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the rule.' };
  const rule = parsed.data;
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) {
    try { return { ok: true, rules: demoRules().save(rule) }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Failed.' }; }
  }
  const step = await ensureStepUp(ceo.db, (s) => ruleSaveNeed({
    enabled: rule.enabled, enrolled: s.factorId !== null, totpAt: s.totpAt, nowSec: Math.floor(Date.now() / 1000),
  }), totp);
  if (!step.ok) return step;
  const r = await ceo.db.rpc('save_auto_approve_rule', { p_rule: rule });
  if (r.error) return { ok: false, error: friendly(r.error.message), stepUp: isStepUpError(r.error.message) || undefined };
  return { ok: true, rules: await listRules(ceo.db) };
}

export async function deleteAutoApproveRuleAction(input: { id: string }): Promise<SecurityResult<{ rules: AutoApproveRule[] }>> {
  if (!FACTOR_ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown rule.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) return { ok: true, rules: demoRules().remove(input.id) };
  const r = await ceo.db.rpc('delete_auto_approve_rule', { p_id: input.id });
  if (r.error) return { ok: false, error: friendly(r.error.message) };
  return { ok: true, rules: await listRules(ceo.db) };
}

async function listRules(db: Db): Promise<AutoApproveRule[]> {
  const r = await db.from('plan_auto_approve_rules').select('*').order('created_at').order('id');
  return (r.data ?? []) as AutoApproveRule[];
}
