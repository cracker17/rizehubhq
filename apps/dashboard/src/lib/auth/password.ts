// CEO password rules (Admin → Security, docs/09 "CEO password"). Pure functions so the server actions and the forms
// share one set of rules and they are unit-tested. Supabase Auth hashes with bcrypt, which ignores bytes after 72.
import { lastAmrAt, type AmrClaim } from './stepUp';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX_BYTES = 72;
/** A password-reset link signs in with amr method 'recovery'; the new password must be set within this window. */
export const RECOVERY_MAX_AGE_SECONDS = 15 * 60;

/** Why `next` can't be the new password, or null when it is fine. */
export function passwordProblem(next: string, opts: { current?: string | null; email?: string | null } = {}): string | null {
  if (next.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (new TextEncoder().encode(next).length > PASSWORD_MAX_BYTES) return `Use at most ${PASSWORD_MAX_BYTES} characters (fewer with emoji or accents).`;
  if (/^(.)\1+$/.test(next)) return 'Pick something less repetitive.';
  if (opts.current && next === opts.current) return 'The new password must be different from the current one.';
  const local = opts.email?.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && next.toLowerCase().includes(local)) return 'Don’t put your email name in the password.';
  return null;
}

/** True when this session came from a password-reset link in the last RECOVERY_MAX_AGE_SECONDS. */
export function recoveryFresh(amr: AmrClaim | null | undefined, nowSec: number, maxAgeSec = RECOVERY_MAX_AGE_SECONDS): boolean {
  const at = lastAmrAt(amr, ['recovery']);
  return at !== null && at >= nowSec - maxAgeSec && at <= nowSec + 60;
}
