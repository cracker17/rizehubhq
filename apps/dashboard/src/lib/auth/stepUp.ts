// CEO TOTP 2FA decisions (docs/09 "Two-factor (TOTP)"). Pure functions so the middleware, server actions and UI share
// one set of rules and they are unit-tested. The database enforces the same rules (is_ceo() needs aal2 once enrolled,
// decide_approval() needs a fresh TOTP for high-risk approvals): supabase/migrations/20260929000000_totp_auto_approve.sql.

/** A TOTP code verified within this many seconds counts as a fresh step-up (same window as ceo_totp_fresh() in SQL). */
export const STEP_UP_MAX_AGE_SECONDS = 300;

export type RiskLevel = 'high' | 'normal';

export interface ApprovalLike { kind: string; payload: Record<string, unknown> | null | undefined }

/**
 * High-risk = an approval whose "approve" changes the outside world: kind 'external_action' with payload.type
 * 'external_action' (agent/tool proposals such as publish, merge, deploy, send, spend; RizeHub actions; outreach
 * email batches). Agent questions, failures, QA escalations, planning failures and Vault 2FA code relays are
 * 'normal'. The agent-written `risk` label never lowers this. Mirrors approval_is_high_risk() in SQL.
 */
export function approvalRisk(ap: ApprovalLike): RiskLevel {
  const p = (ap.payload ?? {}) as { type?: unknown; vault?: { kind?: unknown } };
  if (ap.kind !== 'external_action' || p.type !== 'external_action') return 'normal';
  if (p.vault && typeof p.vault === 'object' && p.vault.kind === '2fa') return 'normal';
  return 'high';
}

/** Supabase access-token amr claim: objects {method, timestamp} (or bare strings from custom hooks, no timestamp). */
export type AmrClaim = ReadonlyArray<{ method?: string; timestamp?: number } | string>;

/** Epoch seconds of the latest TOTP verification in this session, or null. */
export function lastTotpAt(amr: AmrClaim | null | undefined): number | null {
  return lastAmrAt(amr, ['totp', 'mfa/totp']);
}

/** Epoch seconds of the latest amr entry with one of `methods` (e.g. 'recovery' after a password-reset link), or null. */
export function lastAmrAt(amr: AmrClaim | null | undefined, methods: readonly string[]): number | null {
  let latest: number | null = null;
  for (const e of amr ?? []) {
    if (typeof e !== 'object' || !e) continue;
    if (!e.method || !methods.includes(e.method)) continue;
    if (typeof e.timestamp !== 'number' || !Number.isFinite(e.timestamp)) continue;
    if (latest === null || e.timestamp > latest) latest = e.timestamp;
  }
  return latest;
}

export type StepUpNeed = 'not_needed' | 'fresh' | 'required';

/**
 * Does approving need a TOTP code now?
 * - reject / request changes, or a normal-risk approval → not_needed
 * - no verified TOTP factor → not_needed (nothing to step up with; the dashboard asks the CEO to set up 2FA)
 * - TOTP verified in the last STEP_UP_MAX_AGE_SECONDS → fresh
 * - otherwise → required
 */
export function stepUpNeed(input: {
  decision: 'approve' | 'changes' | 'reject'; risk: RiskLevel; enrolled: boolean; totpAt: number | null; nowSec: number;
  maxAgeSec?: number;
}): StepUpNeed {
  if (input.decision !== 'approve' || input.risk !== 'high' || !input.enrolled) return 'not_needed';
  const max = input.maxAgeSec ?? STEP_UP_MAX_AGE_SECONDS;
  if (input.totpAt !== null && input.totpAt >= input.nowSec - max && input.totpAt <= input.nowSec + 60) return 'fresh';
  return 'required';
}

/** Turning an auto-approve rule on loosens the approval gate, so it needs the same fresh step-up. */
export function ruleSaveNeed(input: { enabled: boolean; enrolled: boolean; totpAt: number | null; nowSec: number }): StepUpNeed {
  return stepUpNeed({ decision: input.enabled ? 'approve' : 'reject', risk: 'high', enrolled: input.enrolled, totpAt: input.totpAt, nowSec: input.nowSec });
}

/** Error text from the database when the step-up is missing (ceo_step_up_guard()). */
export function isStepUpError(message: string | null | undefined): boolean {
  return /step_up_required/i.test(message ?? '');
}

/** A 6-digit authenticator code as typed ("482 913" → "482913"), or null. */
export function normalizeTotp(input: unknown): string | null {
  const code = String(input ?? '').replace(/[\s-]+/g, '');
  return /^\d{6}$/.test(code) ? code : null;
}

export type Aal = 'aal1' | 'aal2' | null;

/** Whether this session still has to pass the TOTP step at sign-in (a verified factor exists, session is not aal2). */
export function needsTotpAtSignIn(input: { currentLevel: string | null; hasVerifiedFactor: boolean }): boolean {
  return input.hasVerifiedFactor && input.currentLevel !== 'aal2';
}

export type GateAction = 'pass' | 'to_login' | 'to_totp' | 'to_home';

/**
 * Middleware routing (LIVE mode). `totpPending` = signed in with the password but the TOTP step is still open.
 * Public pages always pass; /login is the only page a half-signed-in session may see (its TOTP step).
 */
export function authGate(input: { signedIn: boolean; totpPending: boolean; path: string; isPublic: boolean; step: string | null }): GateAction {
  const onLogin = input.path === '/login';
  if (!input.signedIn) return input.isPublic ? 'pass' : 'to_login';
  if (input.totpPending) {
    if (onLogin) return input.step === 'totp' ? 'pass' : 'to_totp';
    return input.isPublic ? 'pass' : 'to_totp';
  }
  return onLogin ? 'to_home' : 'pass';
}

/** Only same-site relative paths are followed after sign-in. */
export function safeNext(next: unknown): string {
  const n = typeof next === 'string' ? next : '/';
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
}
