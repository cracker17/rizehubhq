import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionLine, esc, formatApproval, formatBudget, formatQuickSummary, formatReport, formatStatus, truncate } from './format';
import { approval } from './fakeBotDb';
import type { BotReport } from './types';

const names = new Map([['writer', 'Content Writer'], ['designer', 'Graphic Designer'], ['web-dev', 'Web Developer'], ['coo', 'COO']]);

test('plan message matches docs/08 (client, tasks with dependencies, cost, due)', () => {
  const ap = approval({
    kind: 'plan', agent_id: 'coo', title: 'Plan: Bundle landing page', payload: {
      estimated_cost_usd: 4.2, due_date: '2026-10-02', tasks: [
        { key: 'copy', agent_id: 'writer', title: 'landing copy', depends_on: [] },
        { key: 'wire', agent_id: 'designer', title: 'wireframe', depends_on: ['copy'] },
        { key: 'build', agent_id: 'web-dev', title: 'build on unpublished theme', depends_on: ['wire'] },
        { key: 'ads', agent_id: 'designer', title: '3 ad graphics', depends_on: ['copy'] },
      ],
    },
  });
  assert.equal(formatApproval(ap, names), [
    '📋 <b>PLAN</b> · Madam Muse — Bundle landing page',
    '4 tasks · est. $4.20 · due Fri, Oct 2',
    '1. Content Writer — landing copy',
    '2. Graphic Designer — wireframe (after 1)',
    '3. Web Developer — build on unpublished theme (after 2)',
    '4. Graphic Designer — 3 ad graphics (after 1)',
  ].join('\n'));
});

test('deliverable message shows the QA score; urgent is flagged; HTML is escaped', () => {
  const text = formatApproval(approval({ title: 'Copy <v2> & more', requests: { priority: 'urgent', title: null, due_date: null } }), names);
  assert.match(text, /^🔴 <b>URGENT<\/b> · ✅ <b>QA PASSED 92\/100<\/b> · Copy &lt;v2&gt; &amp; more \(Content Writer\)/);
  assert.match(text, /540 words, keyword in H1, 3 CTAs/);
});

test('questions, failures and escalations get their own headers', () => {
  assert.match(formatApproval(approval({ kind: 'external_action', payload: { type: 'question', question: 'Which hero?', options: ['A', 'B'] } }), names),
    /❓ <b>QUESTION<\/b> · Content Writer\nWhich hero\?\nOptions: A \/ B/);
  assert.match(formatApproval(approval({ kind: 'external_action', title: 'Stuck: Build section', payload: { type: 'task_failed', reason: 'No theme access' } }), names),
    /⚠️ <b>TASK FAILED<\/b> · Build section \(Content Writer\)\nNo theme access/);
  assert.match(formatApproval(approval({ kind: 'external_action', payload: { type: 'qa_escalation' }, title: 'QA keeps failing: Ads' }), names), /🔁 <b>QA KEEPS FAILING<\/b> · Ads/);
  const brain = formatApproval(approval({ kind: 'external_action', agent_id: 'coo', payload: { type: 'brain_proposal', kind: 'next_step', project: 'spicy-voyage', project_name: 'Spicy <Voyage>', text: 'Add the pickup map' } }), names);
  assert.match(brain, /🧠 <b>BRAIN<\/b> · next step for Spicy &lt;Voyage&gt;/);
  assert.match(brain, /Add the pickup map/);
  assert.match(brain, /Approve = save to the project memory/);
  assert.doesNotMatch(brain, /Manual step/);
});

test('decided message: "✅ Approved by you 14:02" in Manila time, with the note for changes', () => {
  assert.equal(decisionLine({ status: 'approved', decided_at: '2026-09-28T06:02:00Z', decided_via: 'telegram', ceo_note: null }), '<b>✅ Approved by you 14:02</b>');
  assert.equal(decisionLine({ status: 'changes_requested', decided_at: '2026-09-28T06:02:00Z', decided_via: 'telegram', ceo_note: 'Shorter <h1>' }),
    '<b>✏️ Changes requested by you 14:02</b>\n“Shorter &lt;h1&gt;”');
  assert.equal(decisionLine({ status: 'rejected', decided_at: '2026-09-28T06:02:00Z', decided_via: 'dashboard', ceo_note: null }), '<b>❌ Rejected by you 14:02</b> (dashboard)');
  const done = formatApproval(approval({ status: 'approved', decided_at: '2026-09-28T06:02:00Z', decided_via: 'telegram', requests: { priority: 'urgent', title: null, due_date: null } }), names);
  assert.ok(!done.includes('URGENT'));
  assert.match(done, /\n\n<b>✅ Approved by you 14:02<\/b>$/);
});

test('digest report message uses the structured data and links to the dashboard', () => {
  const r: BotReport = {
    id: 'r1', agent_id: 'coo', report_date: '2026-09-28', kind: 'daily_digest', body_md: '# x', created_at: '', telegram_sent_at: null,
    data: {
      headline: '3 tasks done, 2 in progress, 1 needs you; $0.42 spent today.',
      counts: { done: 3, in_progress: 2, blocked: 1, approvals_waiting: 2, requests_created: 1 },
      qa: { reviews: 4, passed: 3, pass_rate: 75 }, spend_usd: 0.4211,
      done: [{ title: 'Landing copy', agent_id: 'writer', client: 'Madam Muse' }], in_progress: [{ title: 'Wireframe', agent_id: 'designer', client: null, note: 'working' }],
      blocked: [{ title: 'Ads', agent_id: 'designer', client: null, note: 'Missing fonts' }], approvals: [],
      clients: [{ name: 'Madam Muse', done: 1, in_progress: 0, blocked: 0, spend_usd: 0.35 }],
    },
  };
  const t = formatReport(r, names, 'https://hq.rizehub.ph');
  assert.match(t, /^🌆 <b>CEO digest · Mon, Sep 28<\/b>/);
  assert.match(t, /✅ Done \(1\)\n• Landing copy · Madam Muse · Content Writer/);
  assert.match(t, /🚧 Blocked \/ needs you \(1\)\n• Ads · Graphic Designer <i>\(Missing fonts\)<\/i>/);
  assert.match(t, /📥 2 approvals waiting/);
  assert.match(t, /🧪 QA pass rate 75% \(3\/4\) · 💸 Spend \$0\.42/);
  assert.match(t, /• Madam Muse: 1 done, 0 in progress, \$0\.35/);
  assert.match(t, /🔗 https:\/\/hq\.rizehub\.ph\/reports\?date=2026-09-28$/);
});

test('reports without data fall back to the markdown body', () => {
  const t = formatReport({ id: 'r', agent_id: 'coo', report_date: '2026-09-28', kind: 'weekly', body_md: '# Weekly\n- **3** done', data: {}, created_at: '', telegram_sent_at: null }, names, 'https://x.ph');
  assert.match(t, /<b>Weekly<\/b>\n• <b>3<\/b> done/);
  assert.match(t, /tab=weekly/);
});

test('quick summary, budget and status', () => {
  const q = formatQuickSummary({ spend_usd: '1.5', qa: { reviews: 2, passed: 1 }, done: [{ title: 'A', agent_id: 'writer' }], in_progress: [], blocked: [], approvals_waiting: [{ title: 'x', kind: 'plan' }] }, names, 'today 14:02');
  assert.match(q, /1 done · 0 in progress · 0 blocked · 1 approvals waiting/);
  assert.match(q, /🧪 QA 50% \(1\/2\) · 💸 Spend today \$1\.50/);
  const b = formatBudget({ today: 1.2, month: 21, topToday: [{ actor: 'writer', usd: 1 }] }, 25, 10, names);
  assert.match(b, /Today: \$1\.20 of \$10\.00 daily \(12%\)/);
  assert.match(b, /This month: \$21\.00 of \$25\.00 \(84%\)\n⚠️ Over 80%/);
  assert.match(b, /Top today: Content Writer \$1\.00/);
  assert.match(formatBudget({ today: 0, month: 0, topToday: [] }, 0, null, names), /no paid budget set/);
  const s = formatStatus([{ id: 'a', name: 'A', status: 'working' }, { id: 'b', name: 'B', status: 'blocked' }], true);
  assert.match(s, /^⏸ <b>Paused<\/b>/);
  assert.match(s, /🙋 Need you \(1\): B/);
});

test('long messages are cut on a line boundary under the Telegram limit', () => {
  const long = Array.from({ length: 400 }, (_, i) => `<b>line ${i}</b> ${'x'.repeat(10)}`).join('\n');
  const t = truncate(long);
  assert.ok(t.length < 4096);
  assert.ok(t.endsWith('\n…'));
  assert.equal((t.match(/<b>/g) ?? []).length, (t.match(/<\/b>/g) ?? []).length);
  assert.equal(esc('<a&b>'), '&lt;a&amp;b&gt;');
});
