import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadKeyring, seal } from '../vault/crypto';
import { connectorContext, type ConnectorFull } from '../connectors/store';
import {
  buildCeoEmail, capContent, ceoEmailTick, classifyApproval, MAX_PER_TICK, oneLine, selectDue, sendCeoTestEmail, subjectFor,
  type CeoEmailDeps, type CeoEmailItem, type CeoMail,
} from './ceoEmail';
import { inline, markdownToHtml, safeUrl } from './markdown';
import { createCeoEmailRoutes } from '../routes/ceoEmail';
import { parseCeoEmailSettings } from '@rizehubhq/shared';

const kr = loadKeyring({ VAULT_MASTER_KEY: randomBytes(32).toString('base64') })!;
const CONN = '11111111-2222-4333-8444-555555555555';
const PASS = 'abcdefghijklmnop';
const ON_AT = '2026-09-30T10:00:00.000Z';
const NOW = new Date('2026-09-30T12:00:00.000Z');
const SETTINGS = { enabled: true, connector_id: CONN, to: 'ceo@example.com', events: { results: true, questions: true, failures: true, plans: false }, enabled_at: ON_AT };

let seq = 0;
function item(o: Partial<CeoEmailItem> = {}): CeoEmailItem {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, event: null, kind: 'deliverable', title: 'Calendar summary', summary: 'This week at a glance · QA 91',
    payload: { output: { summary: 'This week at a glance', content: '# Week\n\n- **Mon**: call' }, qa: { score: 91, summary: 'Clear' } },
    preview_url: null, agent_id: 'coo', status: 'pending', decided_via: null, created_at: '2026-09-30T11:00:00.000Z',
    request_title: 'Summarize my calendar', request_text: 'Summarize my calendar for this week', request_priority: 'normal', client_name: null,
    task_storage: null, attempts: 0, ...o,
  };
}

function connector(o: Partial<ConnectorFull> = {}): ConnectorFull {
  return { id: CONN, kind: 'gmail', status: 'active', name: 'Main', account_email: 'hq@gmail.com', url: null, auth_type: 'app_password', settings: { mode: 'read' },
    sealed: seal(PASS, kr, connectorContext(CONN)), ...o };
}

function harness(o: { settings?: unknown; items?: CeoEmailItem[]; conn?: ConnectorFull | null; send?: CeoEmailDeps['send'] } = {}) {
  const sent: { account: string; pass: string; mail: CeoMail }[] = [];
  const records: { key: string; ok: boolean; error: string | null }[] = [];
  const marks: { id: string; status: string; error: string | null | undefined; used: boolean | undefined }[] = [];
  const pendingCalls: { since: string; events: string[] }[] = [];
  const deps: CeoEmailDeps = {
    settings: async () => ({ value: o.settings === undefined ? SETTINGS : o.settings, timezone: 'Asia/Manila' }),
    pending: async (since, events) => { pendingCalls.push({ since, events }); return o.items ?? []; },
    record: async (key, ok, error) => { records.push({ key, ok, error }); },
    agentNames: async () => new Map([['coo', 'COO'], ['writer', 'Content Writer']]),
    store: {
      get: async (id) => (o.conn === undefined ? connector() : o.conn) && id === CONN ? (o.conn === undefined ? connector() : o.conn) : null,
      mark: async (id, status, error, used) => { marks.push({ id, status, error, used }); },
    },
    keyring: kr, dashboardUrl: 'https://hq.example.com/', now: () => NOW,
    send: o.send ?? (async (account, pass, mail) => { sent.push({ account, pass, mail }); return { messageId: 'm1' }; }),
  };
  return { deps, sent, records, marks, pendingCalls };
}

test('classify: results / plans / questions / failures; actions and Vault 2FA questions are never emailed', () => {
  assert.equal(classifyApproval({ kind: 'deliverable', payload: {} }), 'results');
  assert.equal(classifyApproval({ kind: 'plan', payload: {} }), 'plans');
  assert.equal(classifyApproval({ kind: 'external_action', payload: { type: 'question', question: 'Which color?' } }), 'questions');
  for (const t of ['task_failed', 'planning_failed', 'qa_escalation', 'qa_stuck']) assert.equal(classifyApproval({ kind: 'external_action', payload: { type: t } }), 'failures', t);
  assert.equal(classifyApproval({ kind: 'external_action', payload: { type: 'external_action', action_type: 'gmail.send' } }), null);
  assert.equal(classifyApproval({ kind: 'external_action', payload: { type: 'vault_problem' } }), null);
  assert.equal(classifyApproval({ kind: 'external_action', payload: { type: 'question', vault: { kind: '2fa' } } }), null);
  assert.equal(classifyApproval({ kind: 'something', payload: {} }), null);
});

test('selectDue: only after enabled_at, only switched-on kinds, never 3+ attempts, oldest first, at most 10', () => {
  const s = parseCeoEmailSettings(SETTINGS);
  const before = item({ created_at: '2026-09-30T09:59:59.000Z' });
  const plan = item({ kind: 'plan', title: 'Plan: launch' });
  const action = item({ kind: 'external_action', payload: { type: 'external_action', action_type: 'mcp.call' } });
  const q = item({ kind: 'external_action', payload: { type: 'question', question: 'Budget?' }, created_at: '2026-09-30T10:30:00.000Z' });
  const tired = item({ attempts: 3 });
  const ok = item({ created_at: '2026-09-30T10:05:00.000Z' });
  const { due } = selectDue([before, plan, action, q, tired, ok], s, NOW);
  assert.deepEqual(due.map((d) => d.id), [ok.id, q.id]);
  assert.deepEqual(selectDue([plan], parseCeoEmailSettings({ ...SETTINGS, events: { ...SETTINGS.events, plans: true } }), NOW).due.map((d) => d.id), [plan.id]);
  const many = Array.from({ length: 25 }, () => item());
  assert.equal(selectDue(many, s, NOW).due.length, MAX_PER_TICK);
  assert.deepEqual(selectDue([ok], parseCeoEmailSettings({ ...SETTINGS, enabled: false }), NOW).due, []);
});

test('selectDue: a fresh deliverable waits for its storage links (up to 2 minutes), then goes without them', () => {
  const s = parseCeoEmailSettings(SETTINGS);
  const fresh = item({ created_at: '2026-09-30T11:59:30.000Z' });
  const withFiles = item({ created_at: '2026-09-30T11:59:40.000Z', task_storage: { provider: 'dropbox', folder_url: 'https://www.dropbox.com/home/Apps/HQ', files: [] } });
  const r = selectDue([fresh, withFiles], s, NOW);
  assert.deepEqual(r.due.map((d) => d.id), [withFiles.id]);
  assert.equal(r.waiting, 1);
  assert.deepEqual(selectDue([fresh], s, new Date('2026-09-30T12:02:00.000Z')).due.map((d) => d.id), [fresh.id]);
});

test('tick: sends FROM the chosen account TO settings.to only, records approval:<id>, marks the account used', async () => {
  const a = item({ payload: { output: { summary: 'S', content: 'Reply to boss@evil.example and cc attacker@evil.example', to: 'attacker@evil.example' }, qa: { score: 90 } } });
  const h = harness({ items: [a] });
  const r = await ceoEmailTick(h.deps);
  assert.equal(r.sent, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].account, 'hq@gmail.com');
  assert.equal(h.sent[0].pass, PASS);
  assert.equal(h.sent[0].mail.to, 'ceo@example.com');
  assert.deepEqual(Object.keys(h.sent[0].mail).sort(), ['html', 'subject', 'text', 'to']);
  assert.deepEqual(h.records, [{ key: `approval:${a.id}`, ok: true, error: null }]);
  assert.deepEqual(h.pendingCalls, [{ since: ON_AT, events: ['results', 'questions', 'failures'] }]);
  assert.ok(h.marks.some((m) => m.status === 'active' && m.used === true));
});

test('tick: nothing happens when off, incomplete, or the account is not active (items wait, nothing recorded)', async () => {
  for (const settings of [null, { ...SETTINGS, enabled: false }, { ...SETTINGS, to: 'not-an-address' }, { ...SETTINGS, connector_id: null },
    { ...SETTINGS, events: { results: false, questions: false, failures: false, plans: false } }]) {
    const h = harness({ settings, items: [item()] });
    const r = await ceoEmailTick(h.deps);
    assert.equal(r.skipped, 'off', JSON.stringify(settings));
    assert.equal(h.pendingCalls.length, 0);
    assert.equal(h.sent.length, 0);
  }
  for (const conn of [null, connector({ status: 'needs_reauth' }), connector({ kind: 'ical' })]) {
    const h = harness({ conn, items: [item()] });
    const r = await ceoEmailTick(h.deps);
    assert.equal(r.skipped, 'account');
    assert.equal(h.sent.length + h.records.length, 0);
  }
});

test('tick: an external action in the pending list is skipped even if the database returned it', async () => {
  const h = harness({ items: [item({ kind: 'external_action', payload: { type: 'external_action', action_type: 'gmail.send', spec: { gmail: { to: 'x@y.com' } } } })] });
  const r = await ceoEmailTick(h.deps);
  assert.equal(r.sent, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.records.length, 0);
});

test('tick: a network error records the failure (retried later); a rejected App Password marks needs_reauth and stops', async () => {
  const net = harness({ items: [item(), item()], send: async () => { throw new Error('connect ETIMEDOUT'); } });
  const r1 = await ceoEmailTick(net.deps);
  assert.equal(r1.failed, 2);
  assert.equal(net.records.length, 2);
  assert.ok(net.records.every((x) => !x.ok && /network/i.test(x.error ?? '')));
  assert.ok(!net.marks.some((m) => m.status === 'needs_reauth'));

  const auth = harness({ items: [item(), item(), item()], send: async () => { throw Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { responseText: '' }); } });
  const r2 = await ceoEmailTick(auth.deps);
  assert.equal(r2.failed, 1, 'stops after the first auth failure');
  assert.equal(auth.records.length, 1);
  assert.equal(auth.records[0].ok, false);
  assert.ok(!(auth.records[0].error ?? '').includes(PASS), 'the error never carries the password');
  assert.deepEqual(auth.marks.map((m) => m.status), ['needs_reauth']);
});

test('tick: idempotent through the log: items the database no longer returns are not sent again', async () => {
  const a = item();
  const sentKeys = new Set<string>();
  const h = harness({ items: [a] });
  h.deps.pending = async () => [a].filter((x) => !sentKeys.has(`approval:${x.id}`));
  h.deps.record = async (key, ok) => { if (ok) sentKeys.add(key); };
  await ceoEmailTick(h.deps);
  await ceoEmailTick(h.deps);
  assert.equal(h.sent.length, 1);
});

test('subjects: result, question, plan, failures (prefixes stripped, one line, capped)', () => {
  const ctx = { agentName: (id: string | null) => (id === 'writer' ? 'Content Writer' : id ?? 'Someone'), dashboardUrl: 'https://hq.example.com' };
  assert.equal(subjectFor(item({ title: 'Calendar summary' }), ctx), '✅ Result ready: Calendar summary');
  assert.equal(subjectFor(item({ kind: 'plan', title: 'Plan: Madam Muse launch' }), ctx), '📋 Plan to approve: Madam Muse launch');
  assert.equal(subjectFor(item({ kind: 'external_action', agent_id: 'writer', title: 'Question: tone?', payload: { type: 'question', question: 'Formal or casual\ntone?' } }), ctx),
    '❓ Content Writer asks: Formal or casual tone?');
  assert.equal(subjectFor(item({ kind: 'external_action', title: 'Stuck: Hero copy', payload: { type: 'task_failed', reason: 'x' } }), ctx), '⚠️ Task failed: Hero copy');
  assert.equal(subjectFor(item({ kind: 'external_action', title: "COO couldn't plan this: vague", request_title: null, request_text: 'do the thing', payload: { type: 'planning_failed' } }), ctx),
    '⚠️ Request failed: do the thing');
  assert.equal(subjectFor(item({ kind: 'external_action', title: 'QA keeps failing: Logo', payload: { type: 'qa_escalation' } }), ctx), '⚠️ QA keeps failing: Logo');
  assert.equal(subjectFor(item({ request_priority: 'urgent' }), ctx), '🔴 URGENT · ✅ Result ready: Calendar summary');
  assert.ok(subjectFor(item({ title: 'x'.repeat(400) }), ctx).length <= 150);
  assert.equal(oneLine('a\r\nBcc: evil@x.com'), 'a Bcc: evil@x.com');
});

test('email body: request, agent, QA score, summary, full content, links, storage links and an Open in HQ link; no approve buttons', () => {
  const ctx = { agentName: (id: string | null) => (id === 'coo' ? 'COO' : 'Someone'), dashboardUrl: 'https://hq.example.com/', timezone: 'Asia/Manila' };
  const a = item({
    payload: {
      output: { summary: 'Your week', content: '## Monday\n\n| Time | What |\n|---|---|\n| 09:00 | Standup |\n\n1. First\n2. Second', links: ['https://example.com/doc'],
        storage: { provider: 'dropbox', folder_url: 'https://www.dropbox.com/home/Apps/RizeHub%20HQ', files: [{ name: 'Calendar summary.md', url: 'https://www.dropbox.com/s/abc/file.md' }] } },
      qa: { score: 94, summary: 'Accurate' },
    },
  });
  const m = buildCeoEmail(a, ctx);
  for (const s of ['Summarize my calendar for this week', 'COO', '94/100', 'Your week', 'Accurate', 'Standup', 'https://example.com/doc', 'Calendar summary.md', `https://hq.example.com/approvals?id=${a.id}`, 'RizeHub HQ']) {
    assert.ok(m.html.includes(s), `html has ${s}`);
  }
  for (const s of ['Summarize my calendar for this week', '94/100', '| 09:00 | Standup |', 'https://www.dropbox.com/s/abc/file.md', `Open in HQ: https://hq.example.com/approvals?id=${a.id}`]) {
    assert.ok(m.text.includes(s), `text has ${s}`);
  }
  assert.match(m.html, /<table role="presentation" style="border-collapse:collapse;margin:0 0 14px/);
  assert.match(m.html, /<ol /);
  assert.match(m.html, /no buttons that act/);
  assert.doesNotMatch(m.html, /callback|>Approve<|>Reject</);
  assert.doesNotMatch(m.html, /<script/i);
});

test('email body: plan, question and failure sections', () => {
  const ctx = { agentName: (id: string | null) => ({ coo: 'COO', writer: 'Content Writer' } as Record<string, string>)[id ?? ''] ?? 'Someone', dashboardUrl: 'https://hq.example.com' };
  const plan = buildCeoEmail(item({ kind: 'plan', title: 'Plan: Launch', payload: { tasks: [{ agent_id: 'writer', title: 'Write copy' }], estimated_cost_usd: 1.5, questions_for_ceo: ['Budget?'] } }), ctx);
  assert.ok(plan.html.includes('Content Writer') && plan.html.includes('Write copy') && plan.html.includes('$1.50') && plan.html.includes('Budget?'));
  const q = buildCeoEmail(item({ kind: 'external_action', agent_id: 'writer', payload: { type: 'question', question: 'Which tone?', options: ['Formal', 'Casual'] } }), ctx);
  assert.ok(q.html.includes('Which tone?') && q.html.includes('Casual') && q.html.includes('Waiting for your answer'));
  const f = buildCeoEmail(item({ kind: 'external_action', title: 'Stuck: Hero', payload: { type: 'task_failed', reason: 'Model quota ran out' } }), ctx);
  assert.ok(f.html.includes('Model quota ran out') && f.text.includes('Approve = retry'));
});

test('markdown: HTML and scripts in agent output are escaped; only http(s)/mailto links survive', () => {
  const html = markdownToHtml('# Hi <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) [ok](https://ok.example/a?b=1&c=2) '
    + '"quoted" \'single\'\n\n```\n<b>code</b>\n```\n\n> <iframe src="https://evil"></iframe>\n\n| a | <b>b</b> |\n|---|---|\n| <i>x</i> | y |');
  assert.doesNotMatch(html, /<script|<img|<iframe|<b>|<i>|href="javascript/i);
  assert.equal(inline('[x](javascript:void0)'), 'x (javascript:void0)');
  assert.doesNotMatch(markdownToHtml('[x](data:text/html;base64,PHNjcmlwdD4=)'), /href=/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('href="https://ok.example/a?b=1&amp;c=2"'));
  assert.ok(html.includes('&lt;b&gt;code&lt;/b&gt;'));
  assert.ok(html.includes('&quot;quoted&quot;'));
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,hi'), null);
  assert.equal(safeUrl('/relative'), null);
  assert.equal(safeUrl('https://x.example/"onmouseover=1'), null);
  assert.equal(safeUrl('mailto:me@example.com'), 'mailto:me@example.com');
});

test('markdown: headings, lists, bold/italic, inline code, bare URLs with trailing punctuation', () => {
  const html = markdownToHtml('## Title\n\n- **bold** and *it* and `x<y`\n- see https://a.example/p.\n\nplain_snake_case stays');
  assert.match(html, /<h3 [^>]*>Title<\/h3>/);
  assert.match(html, /<ul [^>]*><li [^>]*><strong>bold<\/strong> and <em>it<\/em> and <code [^>]*>x&lt;y<\/code><\/li>/);
  assert.match(html, /<a href="https:\/\/a\.example\/p" [^>]*>https:\/\/a\.example\/p<\/a>\./);
  assert.ok(html.includes('plain_snake_case stays'));
  assert.equal(inline('<https://a.example>'), inline('<https://a.example>')); // stable
  assert.doesNotMatch(inline('<https://a.example>'), /&lt;https/);
});

test('content is capped at ~50 KB with a note', () => {
  const c = capContent('line\n'.repeat(20_000));
  assert.equal(c.cut, true);
  assert.ok(c.text.length <= 50_000);
  const m = buildCeoEmail(item({ payload: { output: { summary: 's', content: 'x'.repeat(120_000) } } }), { agentName: () => 'COO', dashboardUrl: 'https://hq.example.com' });
  assert.ok(m.html.length < 90_000);
  assert.match(m.html, /was cut at 50,000 characters/);
});

test('test email: goes to the SAVED address from the saved account; needs both saved; route ignores the body and rate-limits', async () => {
  const h = harness({ settings: { ...SETTINGS, enabled: false } });
  const r = await sendCeoTestEmail(h.deps);
  assert.deepEqual(r, { ok: true, to: 'ceo@example.com', from: 'hq@gmail.com' });
  assert.equal(h.sent[0].mail.to, 'ceo@example.com');
  assert.match(h.records[0].key, /^test:2026-09-30T12:00:00/);
  assert.deepEqual(await sendCeoTestEmail(harness({ settings: { ...SETTINGS, to: null } }).deps), { ok: false, error: 'Save the address to send to first.' });
  assert.deepEqual(await sendCeoTestEmail(harness({ settings: { ...SETTINGS, connector_id: null } }).deps), { ok: false, error: 'Save a Gmail account to send from first.' });

  let t = 1_000_000;
  const h2 = harness();
  const [route] = createCeoEmailRoutes(() => h2.deps, () => t);
  assert.equal(route.path, '/notify/ceo-email/test');
  assert.equal(route.auth, 'secret');
  const [s1, b1] = await route.handle({} as never, Buffer.from(JSON.stringify({ to: 'attacker@evil.example' })));
  assert.equal(s1, 200);
  assert.equal((b1 as { to: string }).to, 'ceo@example.com');
  assert.equal(h2.sent[0].mail.to, 'ceo@example.com');
  const [s2] = await route.handle({} as never, Buffer.from('{}'));
  assert.equal(s2, 429);
  t += 21_000;
  assert.equal((await route.handle({} as never, Buffer.from('{}')))[0], 200);
});
