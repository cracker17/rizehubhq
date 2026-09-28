'use server';
// Settings → Security (TOTP 2FA enrollment) and Settings → Auto-approve rules (docs/06 §10, docs/09, docs/05 [3]).
// * Enrollment uses Supabase Auth MFA as the signed-in CEO: enroll → show QR + secret ONCE (never stored or logged
//   here) → verify a code → the factor is verified and the session becomes aal2.
// * Rules are saved through save_auto_approve_rule / delete_auto_approve_rule (validation, audit, step-up in SQL).
//   Turning a rule on needs a fresh 2FA code (it loosens the approval gate).
// DEMO mode keeps rules in memory and fakes enrollment (no real secret).
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { AutoApproveRuleInput, type AutoApproveRule } from '@rizehubhq/shared';
import { ensureStepUp, friendlyMfaError, totpState, verifyTotp } from '@/lib/auth/mfaServer';
import { isStepUpError, ruleSaveNeed } from '@/lib/auth/stepUp';
import { demoRules } from '@/lib/data/autoApproveDemo';

export type SecurityResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; stepUp?: boolean };

type Ceo = { demo: true } | { demo: false; db: NonNullable<Awaited<ReturnType<typeof createSupabaseServer>>> };

async function requireCeo(): Promise<Ceo | { error: string }> {
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

async function listRules(db: NonNullable<Awaited<ReturnType<typeof createSupabaseServer>>>): Promise<AutoApproveRule[]> {
  const r = await db.from('plan_auto_approve_rules').select('*').order('created_at').order('id');
  return (r.data ?? []) as AutoApproveRule[];
}
