// Per-task caps on the built-in runner: MAX_STEPS_PER_TASK / MAX_COST_PER_TASK_USD (stricter of env and role file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBuiltinTask, taskLimits } from './runner';
import { FakeHqDb } from './fakeHqDb';
import { loadRole } from './roles';
import { config } from './config';
import { makeDeps, mockModel, toolCalls } from './testing';

function setup() {
  const db = new FakeHqDb();
  const task = db.addTask({ agent_id: 'writer', status: 'working' });
  return { db, task: { ...task } };
}
const step = (usage?: { inputTokens?: number; outputTokens?: number }) =>
  toolCalls([{ name: 'report_progress', input: { percent: 10, note: 'Still going' } }], usage);

test('defaults: MAX_STEPS_PER_TASK 25, MAX_COST_PER_TASK_USD 1.50; the stricter of env and role wins', () => {
  assert.equal(config.maxStepsPerTask, 25);
  assert.equal(config.maxCostPerTaskUsd, 1.5);
  const writer = loadRole('writer'); // max_turns 40, budget 0.90
  assert.deepEqual(taskLimits(writer), { maxSteps: 25, maxCostUsd: 0.9 });
  assert.deepEqual(taskLimits({ max_turns: 10, budget_usd_per_task: 5 }), { maxSteps: 10, maxCostUsd: 1.5 });
});

test('MAX_STEPS_PER_TASK: loop stops at the global cap and the task fails with the reason', async () => {
  const { db, task } = setup();
  const model = mockModel([step(), step(), step(), step()]);
  const r = await runBuiltinTask(task, makeDeps({ db, model }), { limits: { maxSteps: 2, maxCostUsd: 100 } });
  assert.deepEqual(r.status === 'failed' && r.reason, 'stopped: exceeded max steps 2');
  assert.equal(model.doGenerateCalls.length, 2);
  assert.equal(db.tasks.get(task.id)!.status, 'failed');
  assert.equal(db.callsOf('failTask')[0]?.args[1], 'stopped: exceeded max steps 2');
});

test('MAX_COST_PER_TASK_USD: run stops once the task costs more than the global cap', async () => {
  const { db, task } = setup();
  // 100k input tokens on claude-opus-5-5 = $0.40 per step > $0.25
  const model = mockModel([step({ inputTokens: 100_000, outputTokens: 10 }), step()]);
  const deps = makeDeps({ db, model, provider: 'anthropic', modelId: 'claude-opus-5-5' });
  const r = await runBuiltinTask(task, deps, { limits: { maxSteps: 25, maxCostUsd: 0.25 } });
  assert.equal(r.status, 'budget_exceeded');
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(db.tasks.get(task.id)!.status, 'failed');
  assert.match(String(db.callsOf('failTask')[0]?.args[1]), /^stopped: exceeded \$0\.25 task budget \(\$0\.40\d+ spent\)$/);
});
