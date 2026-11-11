// P2 join flow: an invited person opens https://hq.rizehub.ph/join/<code>, sets a password, and gets an HQ login that
// can only approve the Brain connector (the dashboard keeps them out of everything else). The brain service holds the
// service key, so it creates the auth user; the code is single use and expires after 7 days (brain_people.invite_hash).
import type { Store } from './store/types';
import { sha256hex } from './setup/devices';

export const JOIN_CODE_RE = /^[0-9a-f]{40}$/;
export const MIN_PASSWORD = 12;

export interface InvitePeek { id: string; email: string; name: string; role: string; projects: number }

export async function peekInvite(store: Store, code: string): Promise<InvitePeek | null> {
  if (!JOIN_CODE_RE.test(code)) return null;
  return store.rpc<InvitePeek | null>('brain_invite_peek', { p_code_hash: sha256hex(code) });
}

/** Strong-enough password check, with a message a person can act on. Exported for the dashboard form too. */
export function passwordProblem(pw: string, email: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return 'That password is too long.';
  const local = email.split('@')[0]!.toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return "Don't use your e-mail name in the password.";
  if (/^(.)\1+$/.test(pw)) return 'Pick something less repetitive.';
  return null;
}

export async function joinWithInvite(store: Store, code: string, password: string, log: (m: string) => void): Promise<[number, unknown]> {
  const invite = await peekInvite(store, code);
  if (!invite) return [410, { error: 'This invite has expired or was already used. Ask Julev for a new one.' }];
  const problem = passwordProblem(password, invite.email);
  if (problem) return [400, { error: problem }];
  if (!store.createUser) return [503, { error: 'Joining is not available on this server.' }];
  const user = await store.createUser(invite.email, password);
  if ('error' in user) {
    log(`join: could not create the login for person ${invite.id}: ${user.error}`);
    return [409, { error: /already|exists|registered/i.test(user.error) ? 'An HQ login with this e-mail already exists. Ask Julev to check your invite.' : 'Could not create your login. Try again in a minute.' }];
  }
  const ok = await store.rpc<{ id: string } | null>('brain_invite_accept', { p_code_hash: sha256hex(code), p_user: user.id });
  if (!ok) return [410, { error: 'This invite was used a moment ago. Ask Julev for a new one.' }];
  log(`join: person ${invite.id} joined (${invite.role})`);
  return [200, { ok: true, email: invite.email }];
}
