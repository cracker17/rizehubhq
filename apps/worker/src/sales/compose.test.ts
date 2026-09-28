// compose (CAN-SPAM footer, List-Unsubscribe, threading), one-click unsubscribe tokens + route, SMTP mailer wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { composeMessage, ComposeError, footer, unsubscribeLink, unsubscribeToken, verifyUnsubscribe } from './compose';
import { createUnsubscribeHandler } from './unsubscribe';
import { isPermanentSmtpError, smtpMailer } from './mailer';
import { fakeDb, seedLead, testConfig } from './testKit';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const unsubCfg = () => testConfig({ OUTREACH_UNSUBSCRIBE_URL: 'https://hq.example.test/hooks/unsubscribe', OUTREACH_UNSUBSCRIBE_SECRET: SECRET });
const email = { id: 'e1', to: 'hello@biz.test', subject: 'Your mobile\r\nproduct page', body: 'Hi Ana,\r\n\r\n\r\n\r\nWant the fix list?', in_reply_to: null, references: [] };

test('compose: plain text = body + sender block + postal address + opt-out; headers carry List-Unsubscribe', () => {
  const c = testConfig();
  const m = composeMessage(c, email);
  assert.deepEqual(m.from, { name: 'Julev Ajeto, RizeHub', address: 'julev@getrizehub.test' });
  assert.equal(m.subject, 'Your mobile product page', 'no header injection');
  assert.equal(m.text, 'Hi Ana,\n\nWant the fix list?\n\n--\nJulev Ajeto, RizeHub\n123 Example Street, Davao City 8000, Philippines\n\n'
    + 'Not relevant? Reply "unsubscribe" and we won\'t email you again.\n');
  assert.equal(m.headers['List-Unsubscribe'], '<mailto:julev@getrizehub.test?subject=unsubscribe>');
  assert.equal(m.headers['List-Unsubscribe-Post'], undefined, 'no one-click header without the link');
  assert.match(m.messageId, /^<e1\.[0-9a-f]{8}@getrizehub\.test>$/);
  assert.equal(m.inReplyTo, undefined);
  assert.ok(!/<[a-z][^>]*>/i.test(m.text), 'no HTML');
});

test('compose: one-click link (RFC 8058) when URL + secret are set; follow-ups thread under the last message', () => {
  const c = unsubCfg();
  const m = composeMessage(c, { ...email, in_reply_to: '<a@x>', references: ['<root@x>'] });
  const link = unsubscribeLink(c, email.to)!;
  assert.ok(m.text.includes(`Or opt out in one click: ${link}`));
  assert.equal(m.headers['List-Unsubscribe'], `<mailto:julev@getrizehub.test?subject=unsubscribe>, <${link}>`);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(m.inReplyTo, '<a@x>');
  assert.deepEqual(m.references, ['<root@x>', '<a@x>']);
});

test('compose: refuses (ComposeError) without a postal address, on the main domain or without SMTP', () => {
  for (const env of [{ OUTREACH_PHYSICAL_ADDRESS: '' }, { OUTREACH_FROM_EMAIL: 'julev@rizehub.ph' }, { OUTREACH_SMTP_HOST: '' }]) {
    assert.throws(() => composeMessage(testConfig(env), email), (e: unknown) => e instanceof ComposeError && e.problems.length > 0);
  }
  assert.match(footer(testConfig({ OUTREACH_PHYSICAL_ADDRESS: '' }), email.to), /cannot be sent/);
});

test('unsubscribe tokens: HMAC of the lower-cased address; tampering fails', () => {
  const t = unsubscribeToken('Hello@Biz.test', SECRET);
  assert.equal(t, unsubscribeToken('hello@biz.test', SECRET));
  const e = Buffer.from('hello@biz.test').toString('base64url');
  assert.equal(verifyUnsubscribe(e, t, SECRET), 'hello@biz.test');
  assert.equal(verifyUnsubscribe(Buffer.from('other@biz.test').toString('base64url'), t, SECRET), null, 'token is per address');
  assert.equal(verifyUnsubscribe(e, t, 'another-secret'), null);
  assert.equal(verifyUnsubscribe(e, 'short', SECRET), null);
  assert.equal(verifyUnsubscribe(Buffer.from('not an email').toString('base64url'), t, SECRET), null);
});

const req = (url: string) => ({ url } as http.IncomingMessage);

test('unsubscribe route: a valid link suppresses the address permanently and unsubscribes the lead (GET or form POST)', async () => {
  const db = fakeDb();
  const lead = await seedLead(db, { email: 'hello@unsub.test', email_source_url: 'https://unsub.test/contact' });
  const handle = createUnsubscribeHandler(() => ({ db, secret: SECRET }));
  const link = new URL(unsubscribeLink(unsubCfg(), 'hello@unsub.test')!);
  const [status, body] = await handle(req(`${link.pathname}${link.search}`), Buffer.alloc(0));
  assert.equal(status, 200);
  assert.match(String((body as { message: string }).message), /hello@unsub\.test is unsubscribed/);
  assert.equal(await db.isSuppressed('hello@unsub.test'), true);
  assert.equal(db.leads.get(lead)!.stage, 'unsubscribed');
  // POST form body (List-Unsubscribe-Post) works too
  await seedLead(db, { email: 'two@unsub.test', email_source_url: 'https://unsub.test/team' });
  const l2 = new URL(unsubscribeLink(unsubCfg(), 'two@unsub.test')!);
  const [s2] = await handle(req('/hooks/unsubscribe'), Buffer.from(l2.search.slice(1)));
  assert.equal(s2, 200);
  assert.equal(await db.isSuppressed('two@unsub.test'), true);
});

test('unsubscribe route: bad token → 400 (nothing suppressed); no secret configured → 503', async () => {
  const db = fakeDb();
  const e = Buffer.from('victim@biz.test').toString('base64url');
  const [s] = await createUnsubscribeHandler(() => ({ db, secret: SECRET }))(req(`/hooks/unsubscribe?e=${e}&t=guess`), Buffer.alloc(0));
  assert.equal(s, 400);
  assert.equal(db.suppressed.size, 0);
  const [s503] = await createUnsubscribeHandler(() => ({ db, secret: null }))(req(`/hooks/unsubscribe?e=${e}&t=x`), Buffer.alloc(0));
  assert.equal(s503, 503);
});

test('smtpMailer: pooled TLS transport, no file/URL access, rejected recipients reported (fake transport, no socket)', async () => {
  const cfg = testConfig();
  let opts: Record<string, unknown> = {};
  const sent: Record<string, unknown>[] = [];
  const mailer = smtpMailer(cfg.smtp!, (o) => {
    opts = o;
    return { sendMail: async (m) => { sent.push(m); return { messageId: '<srv@x>', accepted: [{ address: 'hello@biz.test' }], rejected: [], response: '250 OK' }; } };
  });
  assert.equal(opts.requireTLS, true);
  assert.equal(opts.pool, true);
  const info = await mailer.send(composeMessage(cfg, email));
  assert.deepEqual(info, { messageId: '<srv@x>', accepted: ['hello@biz.test'], rejected: [], response: '250 OK' });
  assert.equal(sent[0]!.disableFileAccess, true);
  assert.equal(sent[0]!.disableUrlAccess, true);
  assert.equal(isPermanentSmtpError({ responseCode: 550 }), true);
  assert.equal(isPermanentSmtpError({ responseCode: 552 }), false);
  assert.equal(isPermanentSmtpError({ responseCode: 421 }), false);
  assert.equal(isPermanentSmtpError(new Error('ETIMEDOUT')), false);
});
