// IMAP replies: parse → thread by Message-ID → classify → record; opt-outs suppress; UID state advances only past
// recorded messages. Fake InboxSource / fake ImapFlow client: no sockets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imapInbox, parseRaw, pollInbox, type ImapClientLike, type InboundMessage, type InboxSource, type InboxState } from './inbox';
import { runSendTick } from './sender';
import { draftFirstTouch, fakeDb, recordingMailer, seedLead, T0, testConfig } from './testKit';
import type { FakeSalesDb } from './fakeStore';

const cfg = testConfig();

function source(messages: InboundMessage[], stateOut: InboxState = { uidValidity: '1', lastUid: 0 }): InboxSource & { seen: InboxState[] } {
  const seen: InboxState[] = [];
  return { seen, async fetchNew(state) { seen.push(state); return { messages, state: stateOut }; } };
}

function msg(uid: number, over: Partial<InboundMessage>): InboundMessage {
  return { uid, messageId: `<in-${uid}@lead.test>`, inReplyTo: null, references: [], from: 'someone@else.test', subject: 'Re: Your mobile product page',
    text: '', date: '2026-09-29T01:00:00.000Z', headers: {}, ...over };
}

/** A contacted lead: first touch approved + sent, so it has an outbound Message-ID to reply to. */
async function contacted(db: FakeSalesDb) {
  const lead = await seedLead(db);
  const e = await draftFirstTouch(db, lead);
  db.decide((await db.createDailyBatch(null, false))!, 'approve');
  await runSendTick({ db, mailer: recordingMailer(), cfg, now: T0 });
  const out = db.emails.get(e)!;
  return { lead, messageId: out.message_id!, to: out.to_email! };
}

test('a reply threads by In-Reply-To, stops follow-ups, moves the lead to replied and asks the Sales Agent to draft', async () => {
  const db = fakeDb();
  const { lead, messageId, to } = await contacted(db);
  const src = source([msg(5, { inReplyTo: messageId, from: to, text: 'Sounds good. How long would the fix take?' })], { uidValidity: '7', lastUid: 0 });
  const r = await pollInbox({ db, source: src, cfg });
  assert.deepEqual(r, { processed: 1, replies: 1, unsubscribes: 0, unmatched: 0, skipped: 0 });
  const l = db.leads.get(lead)!;
  assert.equal(l.stage, 'replied');
  assert.equal(l.next_follow_up_at, null);
  const inbound = [...db.emails.values()].find((e) => e.direction === 'in')!;
  assert.equal(inbound.classification, 'question');
  assert.equal(inbound.classified_by, 'heuristic');
  assert.match(db.requests.at(-1)!, /replied \(question\)/);
  assert.deepEqual({ ...(await db.getSetting('sales_imap') as object), polled_at: undefined }, { uidValidity: '7', lastUid: 5, polled_at: undefined });
});

test('an opt-out reply suppresses the address permanently and unsubscribes the lead; no draft can be made after', async () => {
  const db = fakeDb();
  const { lead, messageId, to } = await contacted(db);
  const r = await pollInbox({ db, source: source([msg(1, { inReplyTo: messageId, from: to, text: 'Please remove me from your list.' })]), cfg });
  assert.equal(r.unsubscribes, 1);
  assert.equal(await db.isSuppressed(to), true);
  assert.equal(db.leads.get(lead)!.stage, 'unsubscribed');
  await assert.rejects(draftFirstTouch(db, lead), /unsubscribed/);
});

test('an opt-out from an unknown sender is still suppressed (unmatched)', async () => {
  const db = fakeDb();
  const r = await pollInbox({ db, source: source([msg(1, { from: 'stranger@nowhere.test', text: 'unsubscribe' })]), cfg });
  assert.deepEqual({ unmatched: r.unmatched, unsubscribes: r.unsubscribes }, { unmatched: 1, unsubscribes: 1 });
  assert.equal(await db.isSuppressed('stranger@nowhere.test'), true);
});

test('auto-replies are recorded without a stage change; our own, bounce and duplicate messages are skipped', async () => {
  const db = fakeDb();
  const { lead, messageId, to } = await contacted(db);
  const r = await pollInbox({ db, source: source([
    msg(1, { inReplyTo: messageId, from: to, subject: 'Out of office: back Monday', text: 'I am away.' }),
    msg(2, { from: cfg.fromEmail!, text: 'our own copy' }),
    msg(3, { from: 'mailer-daemon@mx.test', text: 'Delivery failed' }),
    msg(4, { from: '', text: 'no sender' }),
  ]), cfg });
  assert.deepEqual(r, { processed: 4, replies: 1, unsubscribes: 0, unmatched: 0, skipped: 3 });
  assert.equal(db.leads.get(lead)!.stage, 'contacted', 'auto-reply: follow-ups continue');
  assert.equal([...db.emails.values()].find((e) => e.direction === 'in')!.auto_reply, true);
  const again = await pollInbox({ db, source: source([msg(1, { inReplyTo: messageId, from: to, subject: 'Out of office' })]), cfg });
  assert.equal(again.skipped, 1, 'same Message-ID → duplicate');
});

test('a failure stops the poll at that message so it is retried (UID state not advanced past it)', async () => {
  const db = fakeDb();
  const { messageId, to } = await contacted(db);
  const real = db.recordInbound.bind(db);
  let calls = 0;
  db.recordInbound = async (p) => { if (++calls === 2) throw new Error('db down'); return real(p); };
  const logs: string[] = [];
  const r = await pollInbox({ db, source: source([
    msg(10, { inReplyTo: messageId, from: to, text: 'Keen to chat' }),
    msg(11, { from: to, text: 'Also: which platform?' }),
    msg(12, { from: to, text: 'Thanks' }),
  ], { uidValidity: '1', lastUid: 9 }), cfg, log: (m) => logs.push(m) });
  assert.equal(r.processed, 1);
  assert.equal(r.error, 'db down');
  assert.equal((await db.getSetting('sales_imap') as InboxState).lastUid, 10);
  assert.match(logs.join('\n'), /could not record inbound uid 11; will retry/);
});

test('parseRaw: headers, threading ids, lower-cased sender, auto-reply headers', async () => {
  const raw = [
    'From: "Ana Cruz" <Ana@Biz1.test>', 'To: julev@getrizehub.test', 'Subject: Re: Your mobile product page',
    'Message-ID: <reply-1@biz1.test>', 'In-Reply-To: <e1.abcd1234@getrizehub.test>', 'References: <root@getrizehub.test> <e1.abcd1234@getrizehub.test>',
    'Auto-Submitted: auto-replied', 'Date: Tue, 29 Sep 2026 09:00:00 +0800', 'Content-Type: text/plain; charset=utf-8', '',
    'Yes please, send the list.', '',
  ].join('\r\n');
  const m = await parseRaw(42, raw);
  assert.equal(m.uid, 42);
  assert.equal(m.from, 'ana@biz1.test');
  assert.equal(m.messageId, '<reply-1@biz1.test>');
  assert.equal(m.inReplyTo, '<e1.abcd1234@getrizehub.test>');
  assert.deepEqual(m.references, ['<root@getrizehub.test>', '<e1.abcd1234@getrizehub.test>']);
  assert.equal(m.headers['auto-submitted'], 'auto-replied');
  assert.equal(m.date, '2026-09-29T01:00:00.000Z');
  assert.match(m.text, /Yes please/);
});

function fakeImap(uids: number[], raw: (uid: number) => string, mailbox = { uidValidity: 99n, uidNext: 50 }) {
  const calls: { search: Record<string, unknown>[]; fetched: number[][]; released: number; loggedOut: number } = { search: [], fetched: [], released: 0, loggedOut: 0 };
  const client: ImapClientLike = {
    connect: async () => undefined,
    getMailboxLock: async () => ({ release: () => { calls.released++; } }),
    mailbox,
    search: async (q) => { calls.search.push(q); return uids; },
    fetch: (range) => {
      const list = range as number[];
      calls.fetched.push(list);
      return (async function* () { for (const uid of list) yield { uid, source: Buffer.from(raw(uid)) }; })();
    },
    logout: async () => { calls.loggedOut++; },
  };
  return { client, calls };
}
const rawFor = (uid: number) => `From: lead${uid}@biz.test\r\nSubject: Re: hi\r\nMessage-ID: <m${uid}@biz.test>\r\n\r\nhello ${uid}\r\n`;

test('imapInbox: first run searches the last 14 days; later runs fetch only UIDs after lastUid; lock + logout always', async () => {
  const cfg2 = testConfig({ OUTREACH_IMAP_HOST: 'imap.outreach.test', OUTREACH_IMAP_USER: 'u', OUTREACH_IMAP_PASS: 'not-a-real-password' });
  const first = fakeImap([3, 1, 2], rawFor);
  const r1 = await imapInbox(cfg2.imap!, () => first.client).fetchNew({});
  assert.ok(first.calls.search[0]!.since instanceof Date);
  assert.deepEqual(r1.messages.map((m) => m.uid), [1, 2, 3]);
  assert.deepEqual(r1.state, { uidValidity: '99', lastUid: 0 }, 'pollInbox advances lastUid per recorded message');
  assert.equal(first.calls.released, 1);
  assert.equal(first.calls.loggedOut, 1);

  const later = fakeImap([7, 5, 6], rawFor);
  const r2 = await imapInbox(cfg2.imap!, () => later.client).fetchNew({ uidValidity: '99', lastUid: 5 });
  assert.deepEqual(later.calls.search[0], { uid: '6:*' });
  assert.deepEqual(r2.messages.map((m) => m.uid), [6, 7], 'UID 5 (already seen) is dropped');

  const empty = fakeImap([], rawFor);
  const r3 = await imapInbox(cfg2.imap!, () => empty.client).fetchNew({ uidValidity: 'old', lastUid: 30 });
  assert.deepEqual(r3.state, { uidValidity: '99', lastUid: 49 }, 'UIDVALIDITY changed + nothing new: start at uidNext');
  assert.equal(empty.calls.fetched.length, 0);
});
