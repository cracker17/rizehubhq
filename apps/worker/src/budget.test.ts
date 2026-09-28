// Finding #4: agents.daily_budget_usd is enforced before a task starts; the model picker's month-to-date spend
// resets on the Manila month change and is refreshed from the DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DailyBudgetGuard, GlobalDailyBudget, isOverDaily, manilaDay, manilaDayStartIso, manilaMonth, manilaMonthStartIso, resolveDailyBudget } from './budget';
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
  const db = new FakeHqDb(['web-dev', 'writer']);
  db.agents.get('web-dev')!.daily_budget_usd = '1.50';
  db.activity.push(
    usageRow('web-dev', 1.0, '2026-09-27T15:59:00.000Z'), // yesterday in Manila (23:59)
    usageRow('web-dev', 1.0, '2026-09-27T16:00:00.000Z'), // today 00:00 Manila
    usageRow('writer', 5.0, '2026-09-28T01:00:00.000Z'),
  );
  const g = new DailyBudgetGuard(db, { now: () => new Date('2026-09-28T02:00:00Z') });
  assert.deepEqual(await g.check('web-dev'), { over: false, spentUsd: 1, budgetUsd: 1.5, day: '2026-09-28' });
  db.activity.push(usageRow('web-dev', 0.5, '2026-09-28T01:30:00.000Z'));
  assert.equal((await g.check('web-dev')).over, false, 'cached for a short while');
  g.invalidate('web-dev');
  assert.equal((await g.check('web-dev')).over, true);
});

test('loop: an over-budget agent\'s task is re-queued with a note and does not block other agents', async () => {
  const db = new FakeHqDb(['web-dev', 'writer']);
  db.agents.get('web-dev')!.daily_budget_usd = 1;
  db.activity.push(usageRow('web-dev', 1.25, '2026-09-28T01:00:00.000Z'));
  const blocked = db.addTask({ agent_id: 'web-dev', status: 'queued', title: 'Hero section' });
  const other = db.addTask({ agent_id: 'writer', status: 'queued', title: 'Blog outline' });
  const deps = makeDeps({ db, model: mockModel([toolCalls([{ name: 'submit_output', input: { summary: 'done', content: 'x' } }])]) });
  const loop = new WorkerLoop(deps, { pollIntervalMs: 10, maxParallelTasks: 2 });
  await loop.tick();
  await Promise.allSettled([...loop.running.values()]);

  const requeues = db.callsOf('requeueTask');
  assert.equal(requeues.length, 1);
  assert.equal(requeues[0]!.args[0], blocked.id);
  assert.match(String(requeues[0]!.args[1]), /Daily budget reached for web-dev: \$1\.25 spent of \$1\.00 today \(Asia\/Manila 2026-09-28\)/);
  assert.equal(db.tasks.get(blocked.id)!.status, 'queued');
  assert.ok(deps.logs.some((l) => l.includes('writer claimed "Blog outline"')), 'the other agent\'s task started');
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

// ---------- DAILY_AI_BUDGET_USD: global cap (all agents + planning + QA) with 80% / 100% Telegram alerts ----------
const NOW = () => new Date('2026-09-28T02:00:00Z'); // 10:00 Manila

test('resolveDailyBudget: env wins, then settings.daily_budget_usd, else no cap; 0 = no cap', () => {
  assert.equal(resolveDailyBudget(12, { daily_budget_usd: '10' }), 12);
  assert.equal(resolveDailyBudget(null, { daily_budget_usd: '10' }), 10);
  assert.equal(resolveDailyBudget(undefined, {}), null);
  assert.equal(resolveDailyBudget(Number.NaN, { daily_budget_usd: 'abc' }), null);
  assert.equal(resolveDailyBudget(0, {}), null, 'DAILY_AI_BUDGET_USD=0 = no cap');
  assert.equal(resolveDailyBudget(0, { daily_budget_usd: 5 }), null, 'an explicit 0 in env wins over settings');
  assert.equal(resolveDailyBudget(null, { daily_budget_usd: 0 }), null);
});

test('GlobalDailyBudget: counts every actor today (Manila), alerts once at 80% and once at 100%', async () => {
  const db = new FakeHqDb(['coo', 'web-dev', 'qa-lead']);
  db.activity.push(
    usageRow('web-dev', 5, '2026-09-27T15:00:00.000Z'), // yesterday in Manila: ignored
    usageRow('web-dev', 4, '2026-09-28T01:00:00.000Z'),
    { ...usageRow('coo', 2, '2026-09-28T01:10:00.000Z'), action: 'usage.plan' },
    { ...usageRow('qa-lead', 2.5, '2026-09-28T01:20:00.000Z'), action: 'usage.qa' },
  );
  const g = new GlobalDailyBudget(db, { budgetUsd: 10, now: NOW, cacheMs: 0 });
  assert.deepEqual(await g.check(), { over: false, spentUsd: 8.5, budgetUsd: 10, day: '2026-09-28', pct: 85 });
  assert.deepEqual(db.budgetAlerts.map((a) => a.level), [80]);
  await g.check();
  assert.equal(db.callsOf('recordBudgetAlert').length, 1, 'no second 80% alert the same day');
  db.activity.push(usageRow('writer', 1.5, '2026-09-28T01:30:00.000Z'));
  const c = await g.check();
  assert.equal(c.over, true);
  assert.equal(c.spentUsd, 10);
  assert.deepEqual(db.budgetAlerts.map((a) => [a.level, a.spentUsd, a.budgetUsd]), [[80, 8.5, 10], [100, 10, 10]]);
  // no cap configured → never over, no spend query
  const none = new GlobalDailyBudget(db, { now: NOW });
  assert.deepEqual(await none.check(), { over: false, spentUsd: 0, budgetUsd: null, day: '2026-09-28', pct: null });
});

test('loop: daily AI budget reached → no planning, tasks or QA are claimed (logged once); running work is untouched', async () => {
  const db = new FakeHqDb(['coo', 'web-dev', 'writer', 'qa-lead']);
  db.activity.push(usageRow('web-dev', 10, '2026-09-28T01:00:00.000Z'));
  db.addRequest({ raw_text: 'Plan something' });
  const queued = db.addTask({ agent_id: 'writer', status: 'queued', title: 'Blog outline' });
  const deps = makeDeps({ db, model: mockModel([]) });
  const loop = new WorkerLoop(deps, { pollIntervalMs: 10, maxParallelTasks: 2, dailyBudgetUsd: 10 });
  await loop.tick();
  await loop.tick();
  assert.equal(db.callsOf('claimNextTask').length, 0);
  assert.equal(db.callsOf('claimRequestForPlanning').length, 0);
  assert.equal(db.callsOf('claimQaReview').length, 0);
  assert.equal(db.tasks.get(queued.id)!.status, 'queued');
  assert.equal(deps.logs.filter((l) => l.includes('Daily AI budget reached: $10.00 spent of $10.00 today (Asia/Manila 2026-09-28)')).length, 1);
  assert.deepEqual(db.budgetAlerts.map((a) => a.level), [80, 100]);

  // settings.daily_budget_usd is used when DAILY_AI_BUDGET_USD is not set; raising it lets work start again
  db.settings.daily_budget_usd = 50;
  const loop2 = new WorkerLoop(deps, { pollIntervalMs: 10, maxParallelTasks: 2 });
  await loop2.tick();
  assert.ok(db.callsOf('claimNextTask').length > 0);
  await Promise.allSettled([...loop2.running.values()]);
});

test('ModelPicker: at 100% of the daily budget paid providers stop and the free profile takes over; resets next Manila day', async () => {
  const cfg = loadModelsConfig();
  let now = new Date('2026-09-28T02:00:00Z'); // 10:00 Manila
  const picker = new ModelPicker({
    cfg, profile: 'paid', env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GROQ_API_KEY: 'g' }, monthlyBudgetUsd: 100,
    create: async () => ({}) as never, now: () => now, dailyBudgetUsd: 1,
  });
  const m = await picker.pick('dev');
  assert.equal(m.provider, 'anthropic');
  m.recordCall({ inputTokens: 250_000, outputTokens: 0 }); // Sonnet $2/M → $0.50
  assert.equal(picker.paidBlocked, false);
  picker.setDailySpend({ day: '2026-09-28', spentUsd: 1.2, budgetUsd: 1 }); // the DB total (other runs) crossed the cap
  assert.equal(picker.paidBlocked, true);
  const free = await picker.pick('dev');
  assert.deepEqual([free.provider, free.modelId], ['groq', 'openai/gpt-oss-120b']);
  picker.setDailySpend({ day: '2026-09-28', spentUsd: 0.2, budgetUsd: 1 }); // never lowered within the day
  assert.equal(picker.paidBlocked, true);
  now = new Date('2026-09-28T16:00:01Z'); // next Manila day
  assert.equal(picker.paidBlocked, false);
  assert.equal((await picker.pick('dev')).provider, 'anthropic');
  // raising the cap (or 0 / null = no cap) unblocks at once
  picker.setDailySpend({ day: '2026-09-29', spentUsd: 3, budgetUsd: 2 });
  assert.equal(picker.paidBlocked, true);
  picker.setDailySpend({ day: '2026-09-29', spentUsd: 3, budgetUsd: null });
  assert.equal(picker.paidBlocked, false);
});

test('loop: with free keys (freeFallback) the daily cap only stops paid providers: work keeps flowing, logged once', async () => {
  const db = new FakeHqDb(['coo', 'web-dev', 'writer', 'qa-lead']);
  db.activity.push(usageRow('web-dev', 10, '2026-09-28T01:00:00.000Z'));
  db.addTask({ agent_id: 'writer', status: 'queued', title: 'Blog outline' });
  const deps = makeDeps({ db, model: mockModel([]) });
  const seen: number[] = [];
  const loop = new WorkerLoop(deps, { pollIntervalMs: 10, maxParallelTasks: 2, dailyBudgetUsd: 10, freeFallback: true, onDailySpend: (g) => seen.push(g.spentUsd) });
  await loop.tick();
  await loop.tick();
  assert.ok(db.callsOf('claimNextTask').length > 0, 'tasks are still claimed');
  assert.ok(db.callsOf('claimRequestForPlanning').length > 0, 'planning still runs');
  assert.deepEqual(seen.slice(0, 1), [10], 'the picker is told today’s total');
  assert.equal(deps.logs.filter((l) => l.includes('Paid providers (Anthropic, OpenAI) are stopped until midnight Manila time')).length, 1);
  assert.deepEqual(db.budgetAlerts.map((a) => a.level), [80, 100]);
  await Promise.allSettled([...loop.running.values()]);
});
