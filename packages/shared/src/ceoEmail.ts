// "Email me updates" (docs/08 "Email", docs/15 §5c): the CEO's own email copy of HQ results, questions, plans and
// failures, sent by the worker from one of the connected Gmail accounts to ONE address the CEO sets. Shared by the
// worker (apps/worker/src/notify/ceoEmail.ts) and the dashboard (Admin → Connectors). The settings row `ceo_email` is
// written only through the SQL function ceo_email_set() (supabase/migrations/20261009000000_ceo_email.sql), which
// mirrors the rules below: a valid address, an active Gmail account when on, and a fresh 2FA code to change the address
// or to turn it on.

export const CEO_EMAIL_SETTING_KEY = 'ceo_email';
export const CEO_EMAIL_EVENTS = ['results', 'questions', 'failures', 'plans'] as const;
export type CeoEmailEvent = (typeof CEO_EMAIL_EVENTS)[number];
export type CeoEmailEvents = Record<CeoEmailEvent, boolean>;

/** Results, questions and failures on; plans off (the plan card on Telegram / in HQ is where plans get approved). */
export const CEO_EMAIL_DEFAULT_EVENTS: CeoEmailEvents = { results: true, questions: true, failures: true, plans: false };

export const CEO_EMAIL_EVENT_INFO: Record<CeoEmailEvent, { label: string; help: string }> = {
  results: { label: 'Results', help: 'Every deliverable that passes QA, with the full content and file links.' },
  questions: { label: 'Questions', help: 'When an agent asks you something.' },
  failures: { label: 'Failures', help: 'A task failed, QA keeps failing, or the COO could not plan a request.' },
  plans: { label: 'Plans', help: 'The COO’s plan for a new request (approve it in HQ or Telegram).' },
};

export interface CeoEmailSettings {
  enabled: boolean;
  /** The Gmail connector (connectors.kind = 'gmail') the emails are sent FROM. */
  connector_id: string | null;
  /** The one address emails go TO. Never taken from an agent or an approval. */
  to: string | null;
  events: CeoEmailEvents;
  /** When it was (last) turned on: nothing older is ever emailed (no backfill). */
  enabled_at: string | null;
}

export const CEO_EMAIL_OFF: CeoEmailSettings = { enabled: false, connector_id: null, to: null, events: { ...CEO_EMAIL_DEFAULT_EVENTS }, enabled_at: null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same rule as ceo_email_set() in SQL: one plain address, no display name, no list, no spaces, a dotted domain. */
const EMAIL = /^[^\s@<>(),;:"\\[\]]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function isEmailAddress(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 254 && EMAIL.test(v);
}

export const normalizeEmail = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Reads the settings row value (anything) into a complete, safe shape. Unknown or malformed parts fall back to "off". */
export function parseCeoEmailSettings(v: unknown): CeoEmailSettings {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...CEO_EMAIL_OFF, events: { ...CEO_EMAIL_DEFAULT_EVENTS } };
  const o = v as Record<string, unknown>;
  const ev = (o.events && typeof o.events === 'object' && !Array.isArray(o.events) ? o.events : {}) as Record<string, unknown>;
  const events = Object.fromEntries(CEO_EMAIL_EVENTS.map((k) => [k, typeof ev[k] === 'boolean' ? ev[k] : CEO_EMAIL_DEFAULT_EVENTS[k]])) as CeoEmailEvents;
  const to = normalizeEmail(o.to);
  const enabledAt = typeof o.enabled_at === 'string' && !Number.isNaN(Date.parse(o.enabled_at)) ? o.enabled_at : null;
  return {
    enabled: o.enabled === true,
    connector_id: typeof o.connector_id === 'string' && UUID.test(o.connector_id) ? o.connector_id.toLowerCase() : null,
    to: isEmailAddress(to) ? to : null,
    events,
    enabled_at: enabledAt,
  };
}

/** On, with an account, an address, a start time and at least one event: the worker sends. */
export function ceoEmailReady(s: CeoEmailSettings): boolean {
  return s.enabled && !!s.connector_id && !!s.to && !!s.enabled_at && CEO_EMAIL_EVENTS.some((k) => s.events[k]);
}

/** Mirrors ceo_email_set(): a new address, or turning it on, needs a fresh 2FA code (it decides where results go). */
export function ceoEmailNeedsStepUp(before: CeoEmailSettings, after: { enabled: boolean; to: string | null }): boolean {
  return (after.enabled && !before.enabled) || normalizeEmail(after.to ?? '') !== normalizeEmail(before.to ?? '');
}
