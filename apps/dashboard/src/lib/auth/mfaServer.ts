import 'server-only';
// Supabase Auth MFA (TOTP) calls used by the server actions. supabase-js 2.117 (auth-js 2.117): mfa.enroll,
// mfa.challengeAndVerify, mfa.unenroll, mfa.getAuthenticatorAssuranceLevel; factors come from auth.getUser()
// (validated with Supabase Auth). Codes and secrets are never logged or stored here.
import type { SupabaseClient } from '@supabase/supabase-js';
import { lastTotpAt, normalizeTotp, type AmrClaim, type StepUpNeed } from './stepUp';

export interface TotpState {
  /** Verified TOTP factor id (null = not enrolled). */
  factorId: string | null;
  factorCreatedAt: string | null;
  /** Unverified TOTP factors left over from an abandoned enrollment. */
  unverifiedIds: string[];
  currentLevel: string | null;
  /** Epoch seconds of the last TOTP verification in this session. */
  totpAt: number | null;
}

export async function totpState(db: SupabaseClient): Promise<TotpState | null> {
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  const totp = (user.factors ?? []).filter((f) => f.factor_type === 'totp');
  const verified = totp.find((f) => f.status === 'verified') ?? null;
  const { data: aal } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
  return {
    factorId: verified?.id ?? null,
    factorCreatedAt: verified?.created_at ?? null,
    unverifiedIds: totp.filter((f) => f.status !== 'verified').map((f) => f.id),
    currentLevel: aal?.currentLevel ?? null,
    totpAt: lastTotpAt((aal?.currentAuthenticationMethods ?? []) as AmrClaim),
  };
}

function friendlyMfaError(message: string): string {
  if (/invalid|expired|incorrect/i.test(message)) return 'That code is wrong or expired. Enter the current 6-digit code from your authenticator app.';
  if (/rate|too many/i.test(message)) return 'Too many attempts. Wait a minute and try again.';
  if (/disabled|not enabled|mfa_totp_(enroll|verify)_not_enabled/i.test(message)) return 'TOTP is not enabled for this Supabase project (Auth → Multi-Factor).';
  return message;
}

/** Verifies a code against the factor (challenge + verify). On success the session cookie is upgraded to aal2 with a fresh amr. */
export async function verifyTotp(db: SupabaseClient, factorId: string, rawCode: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const code = normalizeTotp(rawCode);
  if (!code) return { ok: false, error: 'Enter the 6-digit code from your authenticator app.' };
  const { error } = await db.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) return { ok: false, error: friendlyMfaError(error.message) };
  return { ok: true };
}

export type StepUpResult = { ok: true } | { ok: false; stepUp: true; error: string };

/**
 * Makes sure this session may do a step-up-protected action: `need` decides from the current state; when a code is
 * required it must be given (and is verified here, refreshing the session before the RPC runs).
 */
export async function ensureStepUp(db: SupabaseClient, need: (s: TotpState) => StepUpNeed, code: unknown): Promise<StepUpResult> {
  const state = await totpState(db);
  if (!state) return { ok: false, stepUp: true, error: 'Your session expired. Sign in again.' };
  if (need(state) !== 'required') return { ok: true };
  if (code === undefined || code === null || code === '') {
    return { ok: false, stepUp: true, error: 'Enter your 2FA code to confirm.' };
  }
  const v = await verifyTotp(db, state.factorId!, code);
  return v.ok ? v : { ok: false, stepUp: true, error: v.error };
}

export { friendlyMfaError };
