// Finding #4: agents.daily_budget_usd is enforced before a task starts; the model picker's month-to-date spend
// resets on the Manila month change and is refreshed from the DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DailyBudgetGuard, isOverDaily, manilaDay, manilaDayStartIso, manilaMonth, manilaMonthStartIso } from './budget';
import { FakeHqDb } from './fakeHqDb';
import { WorkerLoop } from './loop';
import { makeDeps, mockModel, toolCalls } from './testing';
import { loadModelsConfig } from './models/router';
import { ModelPicker } from './models/usage';

test('Manila day/month boundaries (UTC+8, no DST)', () => {
  const d = new Date('2026-09-30T17:00:00Z'); // 2026-10-01 01:00 in Manila
  assert.equal(manilaDay(d), '2026-10-01');
  assert.equal(manilaMonth(d), '2026-10');
  assert.equal(manilaDayStartIso(d), '2026-09-30T16:00:00.000Z');
  assert.equal(manilaMonthStartIso(d), '2026-09-30T16:00:00.000Z');
  assert.equal(manilaMonthStartIso(new Date('2026-09-30T15:59:59Z')), '2026-08-31T16:00:00.000Z');
});

test('isOverDaily: free-tier ($0) never blocks; reaching the budget does; no budget = no limit', () => {
  assert.equal(isOverDaily(0, 3), false);
  assert.equal(isOverDaily(2.99, 3), false);
  assert.equal(isOverDaily(3, 3), true);
  assert.equal(isOverDaily(0.01, 0), true, 'budget 0 = no paid spend');
  assert.equal(isOverDaily(0, 0), false);
  assert.equal(isOverDaily(100, null), false);
});

function usageRow(actor: string, cost: number, at: string) {
  return { actor, action: 'usage.task', task_id: null, detail: {}, cost_usd: cost, created_at: at };
}

test('DailyBudgetGuard counts only today (Manila) and only this agent', async () => {
  const db = new FakeHqDb(['shopify-dev', 'seo-writer']);
  db.agents.get('shopify-dev')!.daily_budget_usd = '1.50';
  db.activity.push(
    usageRow('shopify-dev', 1.0, '2026-09-27T15:59:00.000Z'), // yesterday in Manila (23:59)
    usageRow('shopify-dev', 1.0, '2026-09-27T16:00:00.000Z'), // today 00:00 Manila
    usageRow('seo-writer', 5.0, '2026-09-28T01:00:00.000Z'),
  );
  const g = new DailyBudgetGuard(db, { now: () => new Date('2026-09-28T02:00:00Z') });
  assert.deepEqual(await g.check('shopify-dev'), { over: false, spentUsd: 1, budgetUsd: 1.5, day: '2026-09-28' });
  db.activity.push(usageRow('shopify-dev', 0.5, '2026-09-28T01:30:00.000Z'));
  assert.equal((await g.check('shopify-dev')).over, false, 'cached for a short while');
  g.invalidate('shopify-dev');
  assert.equal((await g.check('shopify-dev')).over, true);
});

test('loop: an over-budget agent\'s task is re-queued with a note and does not block other agents', async () => {
  const db = new FakeHqDb(['shopify-dev', 'seo-writer']);
  db.agents.get('shopify-dev')!.daily_budget_usd = 1;
  db.activity.push(usageRow('shopify-dev', 1.25, '2026-09-28T01:00:00.000Z'));
  const blocked = db.addTask({ agent_id: 'shopify-dev', status: 'queued', title: 'Hero section' });
  const other = db.addTask({ agent_id: 'seo-writer', status: 'queued', title: 'Blog outline' });
  const deps = makeDeps({ db, model: mockModel([toolCalls([{ name: 'submit_output', input: { summary: 'done', content: 'x' } }])]) });
  const loop = new WorkerLoop(deps, { pollIntervalMs: 10, maxParallelTasks: 2 });
  await loop.tick();
  await Promise.allSettled([...loop.running.values()]);

  const requeues = db.callsOf('requeueTask');
  assert.equal(requeues.length, 1);
  assert.equal(requeues[0]!.args[0], blocked.id);
  assert.match(String(requeues[0]!.args[1]), /Daily budget reached for shopify-dev: \$1\.25 spent of \$1\.00 today \(Asia\/Manila 2026-09-28\)/);
  assert.equal(db.tasks.get(blocked.id)!.status, 'queued');
  assert.ok(deps.logs.some((l) => l.includes('seo-writer claimed "Blog outline"')), 'the other agent\'s task started');
  assert.notEqual(db.tasks.get(other.id)!.status, 'queued');
  assert.ok(deps.logs.some((l) => /Daily budget reached/.test(l)));

  // Only over-budget work left: claiming pauses instead of re-queueing every poll.
  const before = db.callsOf('claimNextTask').length;
  await loop.tick();
  const afterFirst = db.callsOf('claimNextTask').length;
  await loop.tick();
  assert.equal(db.callsOf('claimNextTask').length, afterFirst, 'backs off after a round with only over-budget tasks');
  assert.ok(afterFirst > before);
  assert.equal(db.callsOf('requeueTask').length, 2);
});

test('ModelPicker: month-to-date spend resets on the Manila month change and is refreshed from the DB', async () => {
  const cfg = loadModelsConfig();
  let now = new Date('2026-09-30T15:00:00Z'); // Sep 30, 23:00 Manila
  let dbSpend = 9.5;
  let reads = 0;
  const picker = new ModelPicker({
    cfg, profile: 'claude', env: { ANTHROPIC_API_KEY: 'k' }, monthlyBudgetUsd: 10, spentThisMonthUsd: 9.5,
    create: async () => ({}) as never, now: () => now, refreshEveryMs: 60_000,
    monthSpend: async () => { reads++; return dbSpend; },
  });
  const m = await picker.pick('dev');
  assert.equal(m.provider, 'anthropic');
  m.recordCall({ inputTokens: 200_000, outputTokens: 0 }); // $0.40 → 9.90
  assert.ok(Math.abs(picker.spentThisMonthUsd - 9.9) < 1e-9);
  m.recordCall({ inputTokens: 100_000, outputTokens: 0 }); // → 10.10: over the monthly budget
  await assert.rejects(picker.pick('dev'), /monthly budget reached/);

  now = new Date('2026-09-30T16:00:01Z'); // Oct 1, 00:00:01 Manila: new budget month
  dbSpend = 0;
  const m2 = await picker.pick('dev');
  assert.equal(m2.provider, 'anthropic');
  assert.equal(picker.spentThisMonthUsd, 0);
  assert.equal(reads, 1, 'refreshed from the DB right after the month change');

  // Periodic refresh picks up spend recorded elsewhere (e.g. the DB after other runs), never lowers it.
  dbSpend = 12;
  now = new Date(now.getTime() + 61_000);
  await assert.rejects(picker.pick('dev'), /monthly budget reached/);
  assert.equal(picker.spentThisMonthUsd, 12);
  dbSpend = 1;
  now = new Date(now.getTime() + 61_000);
  await assert.rejects(picker.pick('dev'));
  assert.equal(picker.spentThisMonthUsd, 12);
});
