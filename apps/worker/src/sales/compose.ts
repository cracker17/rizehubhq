// Builds the exact message the worker sends: plain text, the agent's body + a fixed sender block (real sender name,
// RizeHub, physical postal address) + a clear opt-out line, List-Unsubscribe (mailto always; one-click URL when
// configured) and threading headers. No tracking pixels, no HTML, no attachments. CAN-SPAM: refuses without an address.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sendingProblems, type OutreachConfig } from './config';
import type { ClaimedEmail } from './store';

export interface ComposedMessage {
  from: { name: string; address: string };
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  headers: Record<string, string>;
}

export class ComposeError extends Error {
  constructor(readonly problems: string[]) { super(`refusing to send: ${problems.join('; ')}`); }
}

// ---------- one-click unsubscribe tokens (HMAC of the address; no database lookup needed) ----------
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
export function unsubscribeToken(email: string, secret: string): string {
  return createHmac('sha256', secret).update(`unsubscribe:${email.trim().toLowerCase()}`).digest('base64url').slice(0, 32);
}
export function verifyUnsubscribe(emailB64: string, token: string, secret: string): string | null {
  let email: string;
  try { email = Buffer.from(emailB64, 'base64url').toString('utf8').trim().toLowerCase(); } catch { return null; }
  if (!/^[^@\s<>]+@[^@\s<>]+$/.test(email)) return null;
  const want = Buffer.from(unsubscribeToken(email, secret));
  const got = Buffer.from(String(token ?? ''));
  return want.length === got.length && timingSafeEqual(want, got) ? email : null;
}
export function unsubscribeLink(c: OutreachConfig, to: string): string | null {
  if (!c.unsubscribeUrl || !c.unsubscribeSecret) return null;
  const u = new URL(c.unsubscribeUrl);
  u.searchParams.set('e', b64u(to.trim().toLowerCase()));
  u.searchParams.set('t', unsubscribeToken(to, c.unsubscribeSecret));
  return u.toString();
}
export function unsubscribeMailto(c: OutreachConfig): string | null {
  return c.fromEmail ? `mailto:${c.fromEmail}?subject=unsubscribe` : null;
}

/** The fixed sender block + opt-out appended to every outreach email (the agent never writes these itself). */
export function footer(c: OutreachConfig, to: string): string {
  const link = unsubscribeLink(c, to);
  return [
    '--',
    c.fromName,
    c.physicalAddress ?? '[OUTREACH_PHYSICAL_ADDRESS not set: this email cannot be sent]',
    '',
    `Not relevant? Reply "unsubscribe" and we won't email you again.${link ? ` Or opt out in one click: ${link}` : ''}`,
  ].join('\n');
}

/** Body as the agent wrote it (the draft tools refuse bodies with their own sign-off / opt-out) + the fixed footer. */
export function renderText(c: OutreachConfig, body: string, to: string): string {
  const clean = body.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return `${clean}\n\n${footer(c, to)}\n`;
}

export function composeMessage(c: OutreachConfig, e: Pick<ClaimedEmail, 'id' | 'to' | 'subject' | 'body' | 'in_reply_to' | 'references'>): ComposedMessage {
  const problems = sendingProblems(c);
  if (problems.length) throw new ComposeError(problems);
  const fromEmail = c.fromEmail!;
  const domain = fromEmail.slice(fromEmail.lastIndexOf('@') + 1);
  const list = [unsubscribeMailto(c), unsubscribeLink(c, e.to)].filter(Boolean).map((u) => `<${u}>`);
  const headers: Record<string, string> = { 'List-Unsubscribe': list.join(', ') };
  if (unsubscribeLink(c, e.to)) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  const refs = [...new Set([...(e.references ?? []), ...(e.in_reply_to ? [e.in_reply_to] : [])].filter(Boolean))];
  return {
    from: { name: c.fromName, address: fromEmail },
    to: e.to,
    subject: e.subject.replace(/[\r\n]+/g, ' ').trim(),
    text: renderText(c, e.body, e.to),
    messageId: `<${e.id}.${randomBytes(4).toString('hex')}@${domain}>`,
    ...(e.in_reply_to ? { inReplyTo: e.in_reply_to } : {}),
    ...(refs.length ? { references: refs } : {}),
    headers,
  };
}
