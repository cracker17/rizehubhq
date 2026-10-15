import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClassifyError, type ClassifyOutcome } from './classify';
import type { IngestMessage, InboxRow, OperatorChannel, OperatorClient, OperatorDb, UsageEntry } from './db';
import type { ChatMessage } from './browser/chatDom';
import { MaybeSentError, type SendInput, type SendSteps } from './browser/googleChat';
import { Operator, type ChatDriver, type OperatorDeps } from './operator';

const CLIENT: OperatorClient = { slug: 'lvlup', name: 'LvlUp', client_id: null, brain_project: 'lvlup-ventures', profile: 'lvlup',
  my_names: ['Julev'], rules: 'r', enabled: true, paused: false };
const CHANNEL: OperatorChannel = { id: 'ch1', client_slug: 'lvlup', kind: 'google_chat', name: 'Alex', url: 'https://chat.google.com/room/A',
  enabled: true, last_seen_key: null, last_polled_at: null, last_error: null };

/** In-memory stand-in for the SQL functions (the real rules are tested in scripts/db-tests/230-operator.mjs). */
class FakeDb implements Partial<OperatorDb> {
  rows: InboxRow[] = [];
  channel = { ...CHANNEL };
  logs: { action: string; ok: boolean }[] = [];
  usage: UsageEntry[] = [];
  drafts: Record<string, unknown>[] = [];
  done: { id: string; ok: boolean; final: boolean }[] = [];
  blocker: string | null = null;
  async clients() { return [CLIENT]; }
  async channels() { return [this.channel]; }
  async ingest(_ch: string, m: IngestMessage) {
    if (this.rows.some((r) => r.external_id === m.external_id)) return null;
    const id = `r${this.rows.length + 1}`;
    this.rows.push({ id, client_slug: 'lvlup', channel_id: 'ch1', external_id: m.external_id, thread_key: m.thread_key ?? null, space_name: m.space_name ?? null,
      sender_name: m.sender_name, body: m.body, sent_at: m.sent_at ?? null, url: m.url ?? null, mentions_me: m.mentions_me, from_me: m.from_me,
      status: m.from_me || m.baseline ? 'fyi' : 'new', category: null, mode: null, analysis: {}, draft: null, final_text: null, attempts: 0 });
    return id;
  }
  async channelPolled(_ch: string, lastKey: string | null, error: string | null) {
    this.channel = { ...this.channel, last_polled_at: 'now', last_seen_key: lastKey ?? this.channel.last_seen_key, last_error: error };
  }
  async claimNew() { const r = this.rows.find((x) => x.status === 'new'); if (r) r.status = 'classifying'; return r ?? null; }
  async recordDraft(id: string, result: Record<string, unknown>) {
    this.drafts.push(result);
    const r = this.rows.find((x) => x.id === id)!;
    r.status = result.category === 'fyi' ? 'fyi' : 'approved';
    r.final_text = String(result.draft ?? '');
    r.analysis = result;
    return result.category === 'fyi' ? 'fyi' : 'auto';
  }
  async classifyFailed(id: string) { this.rows.find((x) => x.id === id)!.status = 'new'; return 'new'; }
  async claimSend() { const r = this.rows.find((x) => x.status === 'approved'); if (r) r.status = 'sending'; return r ?? null; }
  async maySend() { return this.blocker; }
  async sendDone(id: string, ok: boolean, _e: string | null, _d?: Record<string, unknown>, final = false) {
    this.done.push({ id, ok, final });
    const r = this.rows.find((x) => x.id === id)!;
    r.status = ok ? 'sent' : final ? 'failed' : 'approved';
    return r.status;
  }
  async history() { return this.rows.slice(0, -1); }
  async log(action: string, _c: string | null, _i: string | null, _d?: Record<string, unknown>, ok = true) { this.logs.push({ action, ok }); }
  async brainBundle() { return { project: { slug: 'lvlup-ventures', name: 'LVL UP VC', status: null }, memory: { body: 'Alex is the owner.' }, sessions: [], decisions: [], next_steps: [] }; }
  async brainSearch() { return []; }
  async recordUsage(u: UsageEntry) { this.usage.push(u); }
}

const msg = (id: string, body: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ external_id: id, thread_key: null, sender_name: 'Alex', body, sent_at: '2026-10-15T01:00:00.000Z', mentions_me: false, from_me: false, ...extra });

function setup(o: { chat?: ChatMessage[]; classify?: OperatorDeps['classify']; send?: ChatDriver['send']; gateOk?: boolean; sends?: boolean } = {}) {
  const db = new FakeDb();
  let visible = o.chat ?? [];
  const sent: { input: SendInput; why: string | null }[] = [];
  const prompts: string[] = [];
  const chat: ChatDriver = {
    read: async () => ({ title: 'Alex', messages: visible }),
    send: o.send ?? (async (_c, _ch, input: SendInput, steps: SendSteps) => {
      const why = await steps.lastCheck();
      sent.push({ input, why });
      if (why) throw new Error(`not sent: ${why}`);
      return { sent: true };
    }),
  };
  let t = 1_000_000;
  const op = new Operator({
    db: db as unknown as OperatorDb, chat, pollMs: 120_000, sends: o.sends ?? true, now: () => t, log: () => undefined,
    gate: async () => (o.gateOk === false ? { ok: false, reason: 'the monthly AI budget is 0' } : { ok: true, model: 'claude-test', apiKey: 'k', capUsd: 0.25 }),
    classify: o.classify ?? (async ({ prompt }) => {
      prompts.push(prompt);
      return { result: { category: 'reply', action_types: ['ack'], confidence: 0.9, summary: 's', reasons: 'r', draft: 'On it @Alex', mentions: ['Alex'],
        task_plan: [], needs_from_julev: '', addressed_to_julev: true }, costUsd: 0.004, tokensIn: 900, tokensOut: 80, model: 'claude-test' } satisfies ClassifyOutcome;
    }),
  });
  return { db, op, sent, prompts, setVisible: (m: ChatMessage[]) => { visible = m; }, tick: (ms: number) => { t += ms; } };
}

test('watch: the first read is a baseline (never answered); later messages after the cursor are new; polls respect the interval', async () => {
  const s = setup({ chat: [msg('a', 'old 1'), msg('b', 'old 2')] });
  assert.equal(await s.op.watchTick(), 2);
  assert.deepEqual(s.db.rows.map((r) => r.status), ['fyi', 'fyi']);
  assert.equal(s.db.channel.last_seen_key, 'b');
  s.setVisible([msg('a', 'old 1'), msg('b', 'old 2'), msg('c', 'Can you fix the footer?'), msg('d', 'mine', { from_me: true, sender_name: 'Julev' })]);
  assert.equal(await s.op.watchTick(), 0, 'not due yet');
  s.tick(120_000);
  assert.equal(await s.op.watchTick(), 2);
  assert.deepEqual(s.db.rows.map((r) => r.status), ['fyi', 'fyi', 'new', 'fyi']);
});

test('watch: a read error is recorded on the channel and does not move the cursor', async () => {
  const s = setup();
  (s as unknown as { op: Operator }).op = new Operator({ db: s.db as unknown as OperatorDb, pollMs: 1, sends: true, log: () => undefined,
    chat: { read: async () => { throw new Error('signed out of Google'); }, send: async () => ({ sent: false }) },
    gate: async () => ({ ok: false, reason: 'x' }), classify: async () => { throw new Error('unused'); } });
  assert.equal(await s.op.watchTick(), 0);
  assert.equal(s.db.channel.last_error, 'signed out of Google');
  assert.equal(s.db.channel.last_seen_key, null);
});

test('classify: waits (and says why once) while the budget gate is closed', async () => {
  const s = setup({ gateOk: false });
  s.db.channel.last_seen_key = 'x';
  await s.db.ingest('ch1', { ...msg('n', 'hello') });
  assert.equal(await s.op.classifyTick(), null);
  assert.equal(await s.op.classifyTick(), null);
  assert.equal(s.db.rows[0]!.status, 'new');
  assert.equal(s.db.logs.filter((l) => l.action === 'classify.waiting').length, 1);
});

test('classify → send: memory and history reach the prompt, usage is recorded, the reply is typed with its mention', async () => {
  const s = setup();
  await s.db.ingest('ch1', { ...msg('h', 'earlier', { from_me: true, sender_name: 'Julev' }) });
  await s.db.ingest('ch1', { ...msg('n', 'Is the team page live?') });
  assert.equal(await s.op.classifyTick(), 'auto');
  assert.match(s.prompts[0]!, /Alex is the owner/);
  assert.match(s.prompts[0]!, /Julev \(me\): earlier/);
  assert.equal(s.db.usage[0]!.costUsd, 0.004);
  assert.equal(s.db.drafts[0]!.project, 'lvlup-ventures');
  assert.equal(await s.op.sendTick(), 'sent');
  assert.equal(s.sent[0]!.input.text, 'On it @Alex');
  assert.deepEqual(s.sent[0]!.input.mentions, ['Alex']);
  assert.equal(await s.op.sendTick(), null, 'nothing left');
});

test('send: the last check (kill switch) aborts and the row goes back; OPERATOR_SENDS=off claims nothing', async () => {
  const s = setup();
  await s.db.ingest('ch1', { ...msg('n', 'ping') });
  await s.op.classifyTick();
  s.db.blocker = 'operator paused (kill switch)';
  assert.equal(await s.op.sendTick(), 'approved');
  assert.equal(s.sent[0]!.why, 'operator paused (kill switch)');
  const off = setup({ sends: false });
  await off.db.ingest('ch1', { ...msg('n', 'ping') });
  await off.op.classifyTick();
  assert.equal(await off.op.sendTick(), null);
  assert.equal(off.db.rows[0]!.status, 'approved');
});

test('send: "Enter pressed but not confirmed" is final (never retried: it may have posted)', async () => {
  const s = setup({ send: async () => { throw new MaybeSentError('pressed Enter but the composer did not clear'); } });
  await s.db.ingest('ch1', { ...msg('n', 'ping') });
  await s.op.classifyTick();
  assert.equal(await s.op.sendTick(), 'failed');
  assert.deepEqual(s.db.done[0], { id: 'r1', ok: false, final: true });
});

test('classify: a failed run records what it cost and returns the message to the queue', async () => {
  const s = setup({ classify: async () => { throw new ClassifyError('Claude run stopped: error_max_turns', 0.01, 500, 20, 'claude-test'); } });
  await s.db.ingest('ch1', { ...msg('n', 'ping') });
  assert.equal(await s.op.classifyTick(), 'new');
  assert.equal(s.db.usage[0]!.costUsd, 0.01);
});
