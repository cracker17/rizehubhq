import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, DEMO_CLIENTS, DEMO_TASK_INFO, demoUsageRows, meterLevel, parseDailyCap, summarizeCosts, type UsageRow } from './costsModel';

const TODAY = '2026-09-28';
let seq = 0;
const row = (o: Partial<UsageRow> & { usage_day: string; cost_usd: number }): UsageRow => ({
  id: ++seq, created_at: `${o.usage_day}T02:00:00Z`, agent_id: 'writer', kind: 'task', task_id: null, client_id: null,
  provider: 'anthropic', model: 'claude-haiku-4-5-20251001', tokens_in: 1000, tokens_out: 200, cached_in: 0, ...o,
});

test('parseDailyCap: env wins, 0 / empty / invalid = no cap, settings as fallback', () => {
  assert.equal(parseDailyCap('5'), 5);
  assert.equal(parseDailyCap('0', 9), null);
  assert.equal(parseDailyCap(undefined, '7.5'), 7.5);
  assert.equal(parseDailyCap('', 0), null);
  assert.equal(parseDailyCap('abc', 'x'), null);
});

test('meterLevel: ok below 80%, warn from 80%, over at 100%, none without a cap', () => {
  assert.equal(meterLevel(1, null), 'none');
  assert.equal(meterLevel(7.99, 10), 'ok');
  assert.equal(meterLevel(8, 10), 'warn');
  assert.equal(meterLevel(10, 10), 'over');
});

test('summarizeCosts: today vs cap, range days zero-filled, month total, per agent / client / task / model', () => {
  const rows: UsageRow[] = [
    row({ usage_day: TODAY, cost_usd: 2, agent_id: 'web-dev', task_id: 't1', client_id: 'c1', model: 'claude-sonnet-5', tokens_in: 10_000, cached_in: 6000 }),
    row({ usage_day: TODAY, cost_usd: 0.5, agent_id: 'qa-lead', kind: 'qa', task_id: 't1', client_id: 'c1', provider: 'openai', model: 'gpt-5.5', tokens_in: 4000 }),
    row({ usage_day: TODAY, cost_usd: '1.5' as unknown as number, agent_id: 'writer', task_id: 't2', client_id: 'c2', tokens_in: 6000 }),
    row({ usage_day: TODAY, cost_usd: 0, agent_id: 'sales', kind: 'chat', provider: 'groq', model: 'openai/gpt-oss-120b', tokens_in: 99_999 }),
    row({ usage_day: addDays(TODAY, -3), cost_usd: 1, agent_id: 'coo', kind: 'plan' }),
    row({ usage_day: addDays(TODAY, -10), cost_usd: 4, agent_id: 'web-dev', task_id: 't3', client_id: 'c1' }),
    row({ usage_day: '2026-08-31', cost_usd: 100, agent_id: 'web-dev' }), // last month, outside the 7-day range
    row({ usage_day: addDays(TODAY, 1), cost_usd: 50 }), // clock skew: ignored
  ];
  const s = summarizeCosts(rows, {
    today: TODAY, rangeDays: 7, budgetUsd: 5,
    clientNames: { c1: 'Madam Muse', c2: 'Vinyl Icons' },
    tasks: { t1: { title: 'Bundle section', agent_id: 'web-dev', client_id: 'c1' } },
  });
  assert.equal(s.todayUsd, 4);
  assert.equal(s.pct, 80);
  assert.equal(s.level, 'warn');
  assert.equal(s.rangeUsd, 5);
  assert.equal(s.monthUsd, 9, 'September only');
  assert.equal(s.runs, 5);
  assert.equal(s.days.length, 7);
  assert.deepEqual(s.days[0], { date: addDays(TODAY, -6), usd: 0, runs: 0 });
  assert.deepEqual(s.days.at(-1), { date: TODAY, usd: 4, runs: 4 });
  assert.equal(s.days.find((d) => d.date === addDays(TODAY, -3))!.usd, 1);
  assert.deepEqual(s.byAgent.map((a) => [a.agent_id, a.usd]), [['web-dev', 2], ['writer', 1.5], ['coo', 1], ['qa-lead', 0.5], ['sales', 0]]);
  assert.deepEqual(s.byClient.map((c) => [c.name, c.usd]), [['Madam Muse', 2.5], ['Vinyl Icons', 1.5], ['Internal (no client)', 1]]);
  assert.deepEqual(s.topTasks[0], { task_id: 't1', title: 'Bundle section', agent_id: 'web-dev', client: 'Madam Muse', usd: 2.5, runs: 2 });
  assert.equal(s.topTasks[1]!.title, 'Task t2', 'unknown task falls back to its id');
  assert.equal(s.topTasks[1]!.client, 'Vinyl Icons');
  assert.deepEqual(s.modelMix.map((m) => [m.model, m.sharePct, m.paid]), [
    ['claude-sonnet-5', 40, true], ['claude-haiku-4-5-20251001', 50, true], ['gpt-5.5', 10, true], ['openai/gpt-oss-120b', 0, false],
  ].sort((a, b) => (b[1] as number) - (a[1] as number)));
  assert.equal(s.cacheReadPct, Math.round((6000 / (10_000 + 4000 + 6000 + 1000)) * 1000) / 10, 'paid input only');
});

test('summarizeCosts: no cap → level none, pct null; QA runs do not steal task ownership', () => {
  const rows = [
    row({ usage_day: TODAY, cost_usd: 0.1, agent_id: 'qa-lead', kind: 'qa', task_id: 'tx' }),
    row({ usage_day: TODAY, cost_usd: 0.3, agent_id: 'designer', kind: 'task', task_id: 'tx' }),
  ];
  const s = summarizeCosts(rows, { today: TODAY, budgetUsd: 0 });
  assert.equal(s.level, 'none');
  assert.equal(s.pct, null);
  assert.equal(s.budgetUsd, null);
  assert.equal(s.days.length, 30);
  assert.equal(s.topTasks[0]!.agent_id, 'designer');
});

test('demo rows: 31 Manila days, deterministic, every client and task resolvable', () => {
  const a = demoUsageRows(TODAY);
  assert.deepEqual(a, demoUsageRows(TODAY));
  const days = new Set(a.map((r) => r.usage_day));
  assert.equal(days.size, 31);
  assert.ok(a.every((r) => !r.client_id || DEMO_CLIENTS[r.client_id]));
  assert.ok(a.every((r) => !r.task_id || DEMO_TASK_INFO[r.task_id]));
  const s = summarizeCosts(a, { today: TODAY, budgetUsd: 5, clientNames: DEMO_CLIENTS, tasks: DEMO_TASK_INFO });
  assert.ok(s.rangeUsd > 0 && s.todayUsd > 0);
  assert.ok(s.modelMix.some((m) => !m.paid), 'free chat runs show in the mix');
});
