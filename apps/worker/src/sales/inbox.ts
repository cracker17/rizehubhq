// IMAP poller for the outreach mailbox (imapflow + mailparser). Reads new messages by UID (state in
// settings.sales_imap), threads them in SQL by In-Reply-To / References (sales_record_inbound), classifies with the
// keyword heuristic + model router, and honours opt-outs immediately. Never sends anything and never marks mail read
// (the CEO can still see everything in the mailbox). The client factory is injectable: tests never open a socket.
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import type { MailServer, OutreachConfig } from './config';
import { classifyReply, isAutoReply, type ClassifyDeps } from './classify';
import type { SalesDb } from './store';

export interface InboundMessage {
  uid: number; messageId: string | null; inReplyTo: string | null; references: string[]; from: string; subject: string;
  text: string; date: string | null; headers: Record<string, string | undefined>;
}
export interface InboxState { uidValidity?: string; lastUid?: number }
export interface InboxSource { fetchNew(state: InboxState): Promise<{ messages: InboundMessage[]; state: InboxState }> }

/** The part of ImapFlow we use (tests pass a fake). */
export interface ImapClientLike {
  connect(): Promise<unknown>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  mailbox: false | { uidValidity?: bigint | number | string; uidNext?: number };
  search(q: Record<string, unknown>, o: { uid: true }): Promise<number[] | false>;
  fetch(range: string | number[], q: Record<string, unknown>, o: { uid: true }): AsyncIterable<{ uid: number; source?: Buffer }>;
  logout(): Promise<unknown>;
}
export type ImapFactory = (s: MailServer) => ImapClientLike;

const firstAddress = (a: AddressObject | AddressObject[] | undefined): string => {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  for (const o of list) for (const v of o.value ?? []) if (v.address) return v.address.toLowerCase();
  return '';
};
const headerText = (v: unknown): string | undefined => (v === undefined || v === null ? undefined
  : typeof v === 'string' ? v : typeof v === 'object' && 'value' in (v as object) ? String((v as { value: unknown }).value) : String(v));

export async function parseRaw(uid: number, raw: Buffer | string): Promise<InboundMessage> {
  const p = await simpleParser(raw, { skipHtmlToText: false, skipImageLinks: true, skipTextToHtml: true });
  const refs = Array.isArray(p.references) ? p.references : p.references ? String(p.references).split(/\s+/) : [];
  const headers: Record<string, string | undefined> = {};
  for (const k of ['auto-submitted', 'precedence', 'x-autoreply', 'x-autorespond', 'list-id']) headers[k] = headerText(p.headers.get(k))?.toLowerCase();
  return {
    uid, messageId: p.messageId ?? null, inReplyTo: p.inReplyTo ?? null, references: refs.filter(Boolean),
    from: firstAddress(p.from), subject: p.subject ?? '', text: (p.text ?? '').slice(0, 20_000),
    date: p.date ? p.date.toISOString() : null, headers,
  };
}

export function imapInbox(server: MailServer, factory: ImapFactory = (s) => new ImapFlow({
  host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: s.pass }, logger: false,
}) as unknown as ImapClientLike, o: { firstRunDays?: number; maxPerPoll?: number } = {}): InboxSource {
  return {
    async fetchNew(state) {
      const client = factory(server);
      await client.connect();
      try {
        const lock = await client.getMailboxLock('INBOX');
        try {
          const validity = client.mailbox ? String(client.mailbox.uidValidity ?? '') : '';
          const fresh = !state.lastUid || state.uidValidity !== validity;
          let uids: number[];
          if (fresh) {
            const since = new Date(Date.now() - (o.firstRunDays ?? 14) * 86_400_000);
            uids = (await client.search({ since }, { uid: true })) || [];
          } else {
            uids = (await client.search({ uid: `${state.lastUid! + 1}:*` }, { uid: true })) || [];
          }
          uids = uids.filter((u) => fresh || u > state.lastUid!).sort((a, b) => a - b).slice(0, o.maxPerPoll ?? 50);
          const messages: InboundMessage[] = [];
          if (uids.length) {
            for await (const m of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
              if (m.source) messages.push(await parseRaw(m.uid, m.source));
            }
          }
          messages.sort((a, b) => a.uid - b.uid);
          // pollInbox advances lastUid per processed message; a fresh (re)start with nothing new starts at uidNext.
          const base = fresh ? (uids.length ? 0 : Math.max(0, Number(client.mailbox ? client.mailbox.uidNext ?? 1 : 1) - 1)) : state.lastUid!;
          return { messages, state: { uidValidity: validity, lastUid: base } };
        } finally { lock.release(); }
      } finally { await client.logout().catch(() => undefined); }
    },
  };
}

export interface PollResult { processed: number; replies: number; unsubscribes: number; unmatched: number; skipped: number; error?: string }

const SYSTEM_SENDER = /^(mailer-daemon|postmaster|no-?reply|donotreply)@/i;

/** One poll: new messages → classified → recorded (in UID order; stops at the first failure so it is retried). */
export async function pollInbox(o: { db: SalesDb; source: InboxSource; cfg: Pick<OutreachConfig, 'fromEmail'>; classify?: ClassifyDeps; log?: (m: string, e?: unknown) => void }): Promise<PollResult> {
  const log = o.log ?? (() => undefined);
  const r: PollResult = { processed: 0, replies: 0, unsubscribes: 0, unmatched: 0, skipped: 0 };
  const prev = ((await o.db.getSetting('sales_imap')) ?? {}) as InboxState;
  const { messages, state } = await o.source.fetchNew(prev);
  let lastUid = state.lastUid ?? 0;
  for (const m of messages) {
    try {
      if (!m.from || m.from === o.cfg.fromEmail || SYSTEM_SENDER.test(m.from)) {
        r.skipped++;
      } else {
        const auto = isAutoReply(m.subject, m.headers);
        const c = auto ? null : await classifyReply(m.subject, m.text, o.classify ?? {});
        const res = await o.db.recordInbound({
          message_id: m.messageId, in_reply_to: m.inReplyTo, references: m.references, from: m.from, subject: m.subject, body: m.text,
          received_at: m.date, classification: auto ? null : c!.classification, classified_by: auto ? null : c!.by, auto_reply: auto,
        });
        if (res.duplicate) r.skipped++;
        else if (res.matched === false) { r.unmatched++; if (c?.classification === 'unsubscribe') r.unsubscribes++; }
        else { r.replies++; if (res.unsubscribed) r.unsubscribes++; }
        if (!res.duplicate) log(`[sales] inbound ${auto ? 'auto-reply' : c!.classification}${res.matched === false ? ' (no matching lead)' : ''}`);
      }
      r.processed++;
      lastUid = Math.max(lastUid, m.uid);
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      log(`[sales] could not record inbound uid ${m.uid}; will retry`, r.error);
      break;
    }
  }
  await o.db.setSetting('sales_imap', { uidValidity: state.uidValidity, lastUid, polled_at: new Date().toISOString() });
  return r;
}
