// What a job's browser tools refuse to do by themselves (pure, tested). The workspace browser is logged in to the
// client's real accounts, so anything that changes the outside world from it (publish, send, submit, delete, pay,
// invite…) is not clicked by the agent: the tool refuses and tells it to propose the same click with
// request_action(kind "browser_click"), which becomes a CEO approval and is clicked by the operator only after ✅
// (CLAUDE.md rule 4). Reading, navigating and editing drafts (Designer canvas, CMS editor fields) stay free.
//
// These are word and context heuristics, a second line behind the approval tools: the API tools never expose writes at
// all, and the system prompt says the same. Unknown or unlabeled submit buttons count as risky.
import { checkUrlShape } from 'worker/src/research/net';

/** Words on a control that mean "this changes something outside" (whole words, any case). */
const RISKY = /\b(publish(es|ed|ing)?|unpublish\w*|go live|send|sends|sent|post|posts|reply|submit\w*|delete\w*|remove\w*|archive\w*|discard\w*|destroy\w*|erase\w*|pay|pays|payment|purchase\w*|buy|checkout|check out|order|place order|subscribe\w*|unsubscribe\w*|invite\w*|share|transfer\w*|deploy\w*|merge\w*|confirm\w*|approve\w*|accept\w*|sign up|register|upgrade\w*|downgrade\w*|cancel (plan|subscription)|empty trash|revoke\w*|disconnect\w*|leave (space|chat|workspace)|ship)\b/i;
/** Safe words that often sit next to risky ones ("Save draft", "Preview", "Search", "Cancel", "Close"). */
const SAFE_EXACT = /^(cancel|close|back|next|previous|search|preview|edit|open|view|expand|collapse|more|menu|settings|filter|sort|copy|undo|redo|zoom in|zoom out|save draft|save as draft|ok, got it|got it|dismiss|skip|not now|later)$/i;

export interface ControlInfo {
  /** Visible text, aria-label, title or value (whatever the snapshot found). */
  label: string;
  tag: string;
  /** input/button type attribute (submit, button, password…). */
  type?: string | null;
  /** inside a <form> */
  inForm?: boolean;
  role?: string | null;
}

/** Why clicking this control needs the CEO, or null when the agent may click it. */
export function riskyClick(c: ControlInfo): string | null {
  const label = (c.label ?? '').replace(/\s+/g, ' ').trim();
  if (label && SAFE_EXACT.test(label)) return null;
  const m = RISKY.exec(label);
  if (m) return `"${label.slice(0, 80)}" (${m[0].toLowerCase()})`;
  const tag = (c.tag ?? '').toLowerCase();
  const type = (c.type ?? '').toLowerCase();
  if ((tag === 'button' && (type === 'submit' || (!type && c.inForm))) || (tag === 'input' && (type === 'submit' || type === 'image'))) {
    return `a form submit button${label ? ` "${label.slice(0, 80)}"` : ' with no label'}`;
  }
  return null;
}

/** Hosts where Enter posts a message (chat composers, mail). */
const MESSAGING_HOSTS = [/(^|\.)chat\.google\.com$/, /^mail\.google\.com$/, /(^|\.)slack\.com$/, /^teams\.(microsoft|live)\.com$/,
  /^web\.whatsapp\.com$/, /(^|\.)messenger\.com$/, /^(www\.)?facebook\.com$/, /^discord\.com$/, /^outlook\.(office|live)\.com$/,
  /^(www\.)?linkedin\.com$/, /^app\.intercom\.com$/];

export function isMessagingUrl(url: string): boolean {
  try { const h = new URL(url).hostname.toLowerCase(); return MESSAGING_HOSTS.some((r) => r.test(h)); } catch { return false; }
}

/** Why this key press needs the CEO, or null. Enter (with or without modifiers) in a messaging app may post. */
export function riskyKey(url: string, key: string): string | null {
  const k = key.trim().toLowerCase();
  if (!/(^|\+)(enter|return)$/.test(k)) return null;
  if (isMessagingUrl(url)) return `pressing ${key} on ${new URL(url).hostname} can post a message`;
  return null;
}

export interface FieldInfo { tag: string; type?: string | null; role?: string | null; name?: string | null; placeholder?: string | null; autocomplete?: string | null; label?: string | null }

/** The operator never types into password / one-time-code fields: Julev logs in himself through the viewer. */
export function secretField(f: FieldInfo): boolean {
  const type = (f.type ?? '').toLowerCase();
  const ac = (f.autocomplete ?? '').toLowerCase();
  const hint = `${f.name ?? ''} ${f.placeholder ?? ''} ${f.label ?? ''}`.toLowerCase();
  return type === 'password' || /current-password|new-password|one-time-code/.test(ac) || /\b(password|passcode|otp|2fa|verification code|api key|secret)\b/.test(hint);
}

/** Typing then pressing Enter submits: allowed only in search boxes. */
export function submitAllowed(f: FieldInfo): boolean {
  const type = (f.type ?? '').toLowerCase();
  const role = (f.role ?? '').toLowerCase();
  const hint = `${f.name ?? ''} ${f.placeholder ?? ''} ${f.label ?? ''}`.toLowerCase();
  return type === 'search' || role === 'searchbox' || role === 'combobox' || /\b(search|find|filter)\b/.test(hint);
}

/**
 * A URL the agent may open in the workspace browser: http(s), no credentials, no internal hosts (the browser sits on the
 * operator's private Docker network: single-label names like ws-lvlup or supabase-kong, private IPs, metadata).
 * DNS answers are checked by the caller (assertPublicUrl) before navigating.
 */
export function checkBrowseUrl(raw: string): URL {
  return checkUrlShape(raw);
}

/** Text the model gets back when a click / key needs approval. */
export function needsApproval(why: string, spec: Record<string, unknown>): string {
  return `Refused: ${why} changes the outside world, so you never do it yourself. Propose it with `
    + `request_action({ kind: "browser_click", summary: "<what it does, for Julev>", spec: ${JSON.stringify(spec)} }); `
    + 'Julev approves on Telegram and the operator clicks it for you. Carry on with the rest of the task (or call wait_for_approvals).';
}
