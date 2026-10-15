// Google Chat DOM: selectors, the in-page extractor and the pure normalizer (tested). Google does not publish Chat's DOM
// and changes it without notice, so every selector can be overridden with OPERATOR_GCHAT_SELECTORS (JSON) and
// `pnpm --filter operator probe <profile> <chat url>` shows what each selector finds on the live, logged-in profile.
import { createHash } from 'node:crypto';

export const DEFAULT_SELECTORS = {
  /** One element per message (outermost match wins). */
  message: '[data-message-id]',
  /** Attribute(s) holding a stable message id (comma-separated, first non-empty wins). */
  messageIdAttr: 'data-message-id',
  sender: '[data-hovercard-id][data-name], [data-member-id][data-name], [data-name]',
  timestamp: '[data-absolute-timestamp]',
  text: '[jsname="bgckF"], [data-message-text], div[dir="auto"]',
  thread: '[data-topic-id]',
  threadIdAttr: 'data-topic-id',
  spaceTitle: '[role="main"] [role="heading"], [role="main"] h1',
  composer: 'div[contenteditable="true"][role="textbox"]',
  sendButton: 'button[aria-label^="Send"], div[role="button"][aria-label^="Send"]',
  quoteButton: '[aria-label*="Quote" i]',
  threadReplyButton: '[aria-label^="Reply" i]',
  mentionOption: '[role="listbox"] [role="option"]',
} as const;
export type Selectors = { -readonly [K in keyof typeof DEFAULT_SELECTORS]: string };

export function selectors(overrides: Record<string, string> = {}): Selectors {
  const out = { ...DEFAULT_SELECTORS } as Selectors;
  for (const k of Object.keys(DEFAULT_SELECTORS) as (keyof Selectors)[]) if (overrides[k]?.trim()) out[k] = overrides[k]!.trim();
  return out;
}

export interface RawMessage { id: string; sender: string; ts: string; text: string; thread: string; senderEmail?: string }
export interface RawPage { title: string; messages: RawMessage[] }

/**
 * Runs inside the page (passed as source text, so no bundler helpers leak in). Returns the space title and every
 * message element it can read, in DOM order (oldest first in Chat).
 */
export const EXTRACT_SOURCE = `(sel) => {
  const attr = (el, names) => { for (const a of names.split(',').map((s) => s.trim()).filter(Boolean)) { const v = el.getAttribute(a); if (v) return v; } return ''; };
  const out = [];
  for (const n of Array.from(document.querySelectorAll(sel.message))) {
    if (n.parentElement && n.parentElement.closest(sel.message)) continue;
    const senderEl = n.querySelector(sel.sender);
    const sender = senderEl ? (senderEl.getAttribute('data-name') || senderEl.getAttribute('name') || senderEl.textContent || '').trim() : '';
    const tsEl = n.querySelector(sel.timestamp);
    const ts = tsEl ? ((sel.timestampAttr ? attr(tsEl, sel.timestampAttr) : '') || tsEl.getAttribute('data-absolute-timestamp') || tsEl.getAttribute('datetime') || '') : '';
    const textEl = n.querySelector(sel.text);
    const text = ((textEl ? textEl.innerText : n.innerText) || '').trim();
    const topic = sel.threadChild ? n.querySelector(sel.threadChild) : sel.thread ? n.closest(sel.thread) : null;
    const idEl = sel.idSelector ? (n.querySelector(sel.idSelector) || n) : n;
    const senderEmail = senderEl && sel.senderEmailAttr ? (senderEl.getAttribute(sel.senderEmailAttr) || '') : '';
    out.push({ id: attr(idEl, sel.messageIdAttr), sender, ts, text, thread: topic ? attr(topic, sel.threadIdAttr) : '', senderEmail });
  }
  if (sel.newestFirst) out.reverse();
  const t = document.querySelector(sel.spaceTitle);
  return { title: ((t && t.textContent) || document.title || '').trim(), messages: out };
}`;

export interface ChatMessage {
  external_id: string;
  thread_key: string | null;
  sender_name: string;
  body: string;
  sent_at: string | null;
  mentions_me: boolean;
  from_me: boolean;
  /** Gmail: the sender's address (for the email target list). */
  sender_email?: string | null;
}

/** Chat timestamps: epoch ms or µs (data-absolute-timestamp), epoch s, or ISO. null when unreadable. */
export function parseTimestamp(ts: string): string | null {
  const s = ts.trim();
  if (!s) return null;
  if (/^\d{9,11}\.\d+$/.test(s)) { // Slack: epoch seconds with a fraction ("1700000000.123456")
    const d = new Date(Math.round(Number(s) * 1000));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (/^\d+$/.test(s)) {
    let n = Number(s);
    if (s.length >= 15) n = Math.floor(n / 1000); // µs
    else if (s.length <= 10) n *= 1000;           // s
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const lc = (s: string) => s.trim().toLowerCase();
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isMe(sender: string, myNames: readonly string[]): boolean {
  const s = lc(sender);
  return s === 'you' || s === 'me' || myNames.some((n) => lc(n) === s); // Gmail lists your own mail as "me"
}

export function mentionsMe(text: string, myNames: readonly string[]): boolean {
  return myNames.filter((n) => n.trim()).some((n) => new RegExp(`@${escRe(n.trim())}(?![\\p{L}\\p{N}])`, 'iu').test(text)
    || new RegExp(`@${escRe(n.trim().split(/\s+/)[0]!)}(?![\\p{L}\\p{N}])`, 'iu').test(text));
}

/**
 * Raw rows → messages: the sender carries forward over grouped messages (Chat shows the name once per group), empty
 * rows are dropped, and a message without a DOM id gets a content hash (stable while the message is unchanged).
 */
export function normalizeMessages(raw: RawMessage[], myNames: readonly string[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const seen = new Set<string>();
  let lastSender = '';
  for (const r of raw) {
    const sender = r.sender.trim() || lastSender;
    lastSender = sender;
    const body = r.text.replace(/​/g, '').trim();
    if (!body) continue;
    const sentAt = parseTimestamp(r.ts);
    const id = r.id.trim() || `h:${createHash('sha256').update(`${r.thread}|${r.ts}|${sender}|${body}`).digest('hex').slice(0, 32)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ external_id: id.slice(0, 300), thread_key: r.thread.trim() || null, sender_name: sender, body: body.slice(0, 20000),
      sent_at: sentAt, mentions_me: mentionsMe(body, myNames), from_me: isMe(sender, myNames), sender_email: r.senderEmail?.trim().toLowerCase() || null });
  }
  return out;
}

// ---------- composing ----------

export type Segment = { kind: 'text'; text: string } | { kind: 'mention'; name: string } | { kind: 'newline' };

/** Splits a draft into typed text, @mentions (only names the drafter listed) and line breaks. */
export function composeSegments(draft: string, mentions: readonly string[]): Segment[] {
  const names = [...new Set(mentions.map((m) => m.trim().replace(/^@/, '')).filter(Boolean))].sort((a, b) => b.length - a.length);
  const out: Segment[] = [];
  const lines = draft.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, i) => {
    if (i > 0) out.push({ kind: 'newline' });
    let rest = line;
    const re = names.length ? new RegExp(`@(${names.map(escRe).join('|')})(?![\\p{L}\\p{N}])`, 'u') : null;
    while (rest) {
      const m = re?.exec(rest);
      if (!m) { out.push({ kind: 'text', text: rest }); break; }
      if (m.index > 0) out.push({ kind: 'text', text: rest.slice(0, m.index) });
      out.push({ kind: 'mention', name: m[1]! });
      rest = rest.slice(m.index + m[0].length);
    }
  });
  return out;
}

/** For comparing the composer with the draft: no "@", no zero-width chars, collapsed whitespace. */
export function comparable(text: string): string {
  return text.replace(/[​ ]/g, ' ').replace(/@/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
