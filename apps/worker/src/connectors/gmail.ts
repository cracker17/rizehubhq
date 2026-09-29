// Gmail accounts over IMAP/SMTP with a Google App Password (docs/15 §5). Mailboxes are opened read-only (reading never
// marks mail as read); drafts are appended to the account's Drafts folder; nothing is ever sent from here.
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { simpleParser, type AddressObject } from 'mailparser';

export const GMAIL_IMAP = { host: 'imap.gmail.com', port: 993, secure: true } as const;
export const GMAIL_SMTP = { host: 'smtp.gmail.com', port: 465, secure: true } as const;

export interface MailSummary { id: string; date: string | null; from: string; subject: string; snippet: string; unread: boolean }
export interface MailFull { id: string; date: string | null; from: string; to: string; cc: string; subject: string; text: string; attachments: string[] }
export interface DraftInput { to: string; cc?: string | null; subject: string; body: string; inReplyTo?: string | null }

export interface GmailSession {
  search(query: string, max: number): Promise<MailSummary[]>;
  read(id: string): Promise<(MailFull & { messageId: string | null }) | null>;
  draft(d: DraftInput): Promise<void>;
  close(): Promise<void>;
}
export type GmailOpener = (email: string, appPassword: string) => Promise<GmailSession>;

/** "abcd efgh ijkl mnop" → "abcdefghijklmnop"; null unless it looks like a Google App Password (16 letters). */
export function normalizeAppPassword(v: unknown): string | null {
  const s = String(v ?? '').replace(/[\s-]+/g, '').toLowerCase();
  return /^[a-z]{16}$/.test(s) ? s : null;
}

export function isGmailAddress(v: unknown): boolean {
  return /^[^\s@]{1,64}@(gmail|googlemail)\.com$/i.test(String(v ?? '').trim());
}

/** Plain words for Google's login errors; `reauth` = the stored App Password no longer works. */
export function friendlyGmailError(e: unknown): { message: string; reauth: boolean } {
  const m = e instanceof Error ? `${e.message} ${(e as { responseText?: string }).responseText ?? ''}` : String(e);
  if (/application-specific password required|web login required/i.test(m)) {
    return { message: 'Google wants an App Password, not the normal password (2-Step Verification must be on).', reauth: true };
  }
  if (/authenticationfailed|invalid credentials|username and password not accepted|535|auth/i.test(m)) {
    return { message: 'Google rejected the App Password. Create a new one and replace it in Admin → Connectors.', reauth: true };
  }
  if (/enotfound|etimedout|econnrefused|econnreset|timeout/i.test(m)) return { message: 'Could not reach Gmail (network). Try again.', reauth: false };
  return { message: `Gmail error: ${m.slice(0, 200)}`, reauth: false };
}

const addr = (a: AddressObject | AddressObject[] | undefined) => (Array.isArray(a) ? a.map((x) => x.text).join(', ') : a?.text ?? '');
const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);
function htmlToText(html: string) {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ');
}

export const openGmail: GmailOpener = async (email, appPassword) => {
  const client = new ImapFlow({ ...GMAIL_IMAP, auth: { user: email, pass: appPassword }, logger: false });
  await client.connect();
  const boxes = await client.list();
  const all = boxes.find((b) => b.specialUse === '\\All')?.path ?? 'INBOX';
  const drafts = boxes.find((b) => b.specialUse === '\\Drafts')?.path ?? '[Gmail]/Drafts';
  return {
    async search(query, max) {
      const lock = await client.getMailboxLock(all, { readOnly: true });
      try {
        const uids = ((await client.search({ gmraw: query || 'in:inbox' }, { uid: true })) || []).sort((a, b) => b - a).slice(0, max);
        const out: MailSummary[] = [];
        if (!uids.length) return out;
        for await (const m of client.fetch(uids, { uid: true, flags: true, internalDate: true, source: { maxLength: 16_384 } }, { uid: true })) {
          const p = m.source ? await simpleParser(m.source) : null;
          const body = p?.text ?? (p?.html ? htmlToText(p.html) : '');
          out.push({
            id: String(m.uid), date: (p?.date ?? (m.internalDate instanceof Date ? m.internalDate : null))?.toISOString() ?? null,
            from: addr(p?.from), subject: p?.subject ?? '(no subject)', snippet: oneLine(body, 240), unread: !m.flags?.has('\\Seen'),
          });
        }
        return out.sort((a, b) => Number(b.id) - Number(a.id));
      } finally { lock.release(); }
    },
    async read(id) {
      if (!/^\d{1,12}$/.test(id)) return null;
      const lock = await client.getMailboxLock(all, { readOnly: true });
      try {
        const m = await client.fetchOne(id, { uid: true, source: { maxLength: 400_000 } }, { uid: true });
        if (!m || !m.source) return null;
        const p = await simpleParser(m.source);
        const text = p.text ?? (p.html ? htmlToText(p.html) : '');
        return {
          id, date: p.date?.toISOString() ?? null, from: addr(p.from), to: addr(p.to), cc: addr(p.cc), subject: p.subject ?? '(no subject)',
          text: text.trim().slice(0, 8000), attachments: (p.attachments ?? []).map((a) => a.filename ?? a.contentType).slice(0, 20),
          messageId: p.messageId ?? null,
        };
      } finally { lock.release(); }
    },
    async draft(d) {
      const raw = await new MailComposer({
        from: email, to: d.to, cc: d.cc || undefined, subject: d.subject, text: d.body,
        ...(d.inReplyTo ? { inReplyTo: d.inReplyTo, references: d.inReplyTo } : {}),
      }).compile().build();
      await client.append(drafts, raw, ['\\Draft', '\\Seen']);
    },
    close: async () => { await client.logout().catch(() => undefined); },
  };
};

/** Checks the App Password against IMAP (read) and SMTP (what Gmail would use to send), then logs out. */
export async function testGmailLogin(email: string, appPassword: string, o: { open?: GmailOpener; smtpVerify?: (email: string, pass: string) => Promise<unknown> } = {}):
  Promise<{ ok: true } | { ok: false; error: string; reauth: boolean }> {
  try {
    const s = await (o.open ?? openGmail)(email, appPassword);
    await s.close();
    await (o.smtpVerify ?? ((u, p) => nodemailer.createTransport({ ...GMAIL_SMTP, auth: { user: u, pass: p } }).verify()))(email, appPassword);
    return { ok: true };
  } catch (e) {
    const f = friendlyGmailError(e);
    return { ok: false, error: f.message, reauth: f.reauth };
  }
}
