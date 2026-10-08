// Admin → Connectors → Email me updates (docs/15 §5c): pure form helpers for components/admin/CeoEmailSection.tsx.
import { ceoEmailNeedsStepUp, isEmailAddress, normalizeEmail, type CeoEmailEvents, type CeoEmailSettings } from '@rizehubhq/shared';

export interface GmailOption { id: string; email: string; status: string }
export interface CeoEmailForm { enabled: boolean; connectorId: string; to: string; events: CeoEmailEvents }

/** Saved account if it is still a Gmail connector, else the first active one; address: saved, else that account's. */
export function initialCeoEmailForm(s: CeoEmailSettings, gmail: GmailOption[]): CeoEmailForm {
  const saved = gmail.find((g) => g.id === s.connector_id);
  const pick = saved ?? gmail.find((g) => g.status === 'active') ?? gmail[0];
  return { enabled: s.enabled, connectorId: pick?.id ?? '', to: s.to ?? pick?.email ?? '', events: { ...s.events } };
}

/** What would stop a save (null = fine). Off may be saved half-filled; on needs an active account, an address and an event. */
export function ceoEmailProblem(f: CeoEmailForm, gmail: GmailOption[]): string | null {
  const to = normalizeEmail(f.to);
  if (to && !isEmailAddress(to)) return 'Enter one email address, like you@gmail.com.';
  if (!f.enabled) return null;
  const acc = gmail.find((g) => g.id === f.connectorId);
  if (!acc) return 'Pick a Gmail account to send from.';
  if (acc.status !== 'active') return `${acc.email} is not active. Test it or replace its App Password first.`;
  if (!to) return 'Enter the address to send to.';
  if (!Object.values(f.events).some(Boolean)) return 'Pick at least one kind of update.';
  return null;
}

/** Will this save ask for the 2FA code? (Mirrors ceo_email_set(): a new address, or turning it on.) */
export function ceoEmailSaveNeedsCode(saved: CeoEmailSettings, f: CeoEmailForm): boolean {
  return ceoEmailNeedsStepUp(saved, { enabled: f.enabled, to: normalizeEmail(f.to) || null });
}

export function ceoEmailDirty(saved: CeoEmailSettings, f: CeoEmailForm): boolean {
  return f.enabled !== saved.enabled || (f.connectorId || null) !== saved.connector_id || (normalizeEmail(f.to) || null) !== saved.to
    || (Object.keys(f.events) as (keyof CeoEmailEvents)[]).some((k) => f.events[k] !== saved.events[k]);
}
