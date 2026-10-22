import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { signRizehubBody } from '../rizehub/webhook';
import {
  alertEmailTick, buildAlertEmail, createNotifyHandler, newUptimeState, parseAlert, parseUptimeUrls, uptimeTick,
  type AlertEmailDeps, type AlertStore, type ExternalAlert, type StoredAlert,
} from './externalAlerts';

const SECRET = 'notify_secret_0123456789abcdef0123456789';
const NOW = Date.parse('2026-10-22T02:00:00Z');
const req = (headers: Record<string, string>) => ({ headers }) as unknown as http.IncomingMessage;

class MemStore implements AlertStore {
  rows = new Map<string, StoredAlert & { email_sent_at: string | null; email_error: string | null }>();
  async insert(a: ExternalAlert) {
    if (this.rows.has(a.id)) return { duplicate: true };
    this.rows.set(a.id, { ...a, received_at: new Date(NOW).toISOString(), email_sent_at: null, email_error: null });
    return { duplicate: false };
  }
  async unsentEmail(limit: number) { return [...this.rows.values()].filter((r) => !r.email_sent_at && r.level !== 'warning').slice(0, limit); }
  async markEmailed(id: string, error: string | null) { const r = this.rows.get(id); if (r && !r.email_sent_at) { r.email_sent_at = 'now'; r.email_error = error; } }
}

const signed = (body: string, nowMs = NOW) => req({
  'content-type': 'application/json', 'x-hq-signature': signRizehubBody(body, SECRET), 'x-hq-timestamp': String(Math.floor(nowMs / 1000)),
});

test('parseAlert: validates id, source, level, title and https url; trims long text', () => {
  const ok = parseAlert({ id: 'hd:err:abc', source: 'hushdesk', level: 'critical', title: '  Email   sending failed ', body: 'x'.repeat(5000), url: 'https://hushdesk.tech/app/admin/errors' });
  assert.ok(ok.ok);
  if (ok.ok) { assert.equal(ok.alert.title, 'Email sending failed'); assert.equal(ok.alert.body.length, 4000); }
  assert.equal(parseAlert({ id: 'bad id', source: 'hushdesk', level: 'error', title: 't' }).ok, false);
  assert.equal(parseAlert({ id: 'a', source: 'Hushdesk', level: 'error', title: 't' }).ok, false);
  assert.equal(parseAlert({ id: 'a', source: 'hushdesk', level: 'fatal', title: 't' }).ok, false);
  assert.equal(parseAlert({ id: 'a', source: 'hushdesk', level: 'error', title: ' ' }).ok, false);
  assert.equal(parseAlert({ id: 'a', source: 'hushdesk', level: 'error', title: 't', url: 'http://x.test' }).ok, false);
  assert.equal(parseAlert({ id: 'a', source: 'hushdesk', level: 'error', title: 't', url: 'javascript:alert(1)' }).ok, false);
});

test('/hooks/notify: rejects bad signatures and stale timestamps, stores a valid alert once', async () => {
  const store = new MemStore();
  const handle = createNotifyHandler(() => ({ store, secret: SECRET }), () => NOW);
  const body = JSON.stringify({ id: 'hd:1', source: 'hushdesk', level: 'error', title: 'New error', body: 'TypeError: x is undefined' });
  assert.equal((await handle(req({}), Buffer.from(body)))[0], 401);
  assert.equal((await handle(signed(body, NOW - 400_000), Buffer.from(body)))[0], 401);
  assert.equal((await handle(req({ 'x-hq-signature': signRizehubBody(body, 'other'), 'x-hq-timestamp': String(NOW / 1000) }), Buffer.from(body)))[0], 401);
  assert.deepEqual(await handle(signed(body), Buffer.from(body)), [202, { ok: true, id: 'hd:1', duplicate: false }]);
  assert.deepEqual(await handle(signed(body), Buffer.from(body)), [202, { ok: true, id: 'hd:1', duplicate: true }]);
  const bad = JSON.stringify({ id: 'hd:2', source: 'hushdesk', level: 'nope', title: 't' });
  assert.equal((await handle(signed(bad), Buffer.from(bad)))[0], 400);
  assert.equal((await createNotifyHandler(() => ({ store, secret: '' }), () => NOW)(signed(body), Buffer.from(body)))[0], 503);
  assert.equal(store.rows.size, 1);
});

test('alert email: while "Email me updates" is off, waiting alerts are marked (no flood later) and nothing is sent', async () => {
  const store = new MemStore();
  await store.insert({ id: 'a1', source: 'hushdesk', level: 'critical', title: 'Email sending failed', body: 'Postmark 500', url: 'https://hushdesk.tech/app/admin/errors' });
  const sent: string[] = [];
  const deps = {
    alerts: store, keyring: null, log: () => {}, settings: async () => ({ value: null }),
    store: { get: async () => null, mark: async () => {} },
    send: async (_from: string, _p: string, m: { subject: string }) => { sent.push(m.subject); return { messageId: 'm' }; },
  } as unknown as AlertEmailDeps;
  const r = await alertEmailTick(deps);
  assert.equal(r.skipped, 'off');
  assert.equal(store.rows.get('a1')!.email_error, 'Email me updates (failures) is off');
  assert.equal(sent.length, 0);
  assert.deepEqual(await alertEmailTick(deps), { sent: 0, failed: 0 });
});

test('buildAlertEmail: escaped html, subject with level and app', () => {
  const m = buildAlertEmail({ id: 'x', source: 'hushdesk', level: 'error', title: '<script>', body: 'a\n\nb <i>', url: 'https://hushdesk.tech/x', received_at: '' });
  assert.equal(m.subject, '❗ Hushdesk error: <script>');
  assert.ok(!m.html.includes('<script>'));
  assert.match(m.html, /&lt;i&gt;/);
  assert.match(m.html, /href="https:\/\/hushdesk.tech\/x"/);
});

test('uptime: 2 failures in a row → one critical alert; recovery → one info alert', async () => {
  assert.deepEqual(parseUptimeUrls(' https://hushdesk.tech/api/health, http://no.test ,,https://demo.hushdesk.tech '),
    ['https://hushdesk.tech/api/health', 'https://demo.hushdesk.tech']);
  const store = new MemStore();
  const state = newUptimeState();
  let up = false;
  const probe = async () => ({ ok: up, detail: up ? 'HTTP 200' : 'HTTP 502' });
  let t = NOW;
  const now = () => new Date(t);
  const urls = ['https://hushdesk.tech/api/health'];
  await uptimeTick(urls, state, probe, store, now);
  assert.equal(store.rows.size, 0);
  t += 300_000; await uptimeTick(urls, state, probe, store, now);
  t += 300_000; await uptimeTick(urls, state, probe, store, now);
  const down = [...store.rows.values()];
  assert.equal(down.length, 1);
  assert.equal(down[0]!.level, 'critical');
  assert.equal(down[0]!.title, 'hushdesk.tech is down');
  up = true; t += 600_000; await uptimeTick(urls, state, probe, store, now);
  const all = [...store.rows.values()];
  assert.equal(all.length, 2);
  assert.equal(all[1]!.level, 'info');
  assert.match(all[1]!.body, /after about 15 min/);
  t += 300_000; await uptimeTick(urls, state, probe, store, now);
  assert.equal(store.rows.size, 2);
});
