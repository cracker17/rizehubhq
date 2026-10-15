import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoOperator } from './data/operatorDemoData';
import { DEMO_SCRIPT, DEMO_TAPS, initialDemo, step } from './operatorDemo';

test('demo: the whole story plays to the end; four taps; reply sent, job done with QA, client informed', () => {
  let s = initialDemo(demoOperator());
  assert.equal(s.telegram.length, 0);
  assert.deepEqual(DEMO_TAPS, ['reply', 'merge', 'update', 'memory']);
  let t = Date.parse('2026-10-17T01:00:00Z');
  for (const ev of DEMO_SCRIPT) { s = step(s, ev, t); t += 1000; }
  assert.equal(s.done, true);
  const job = s.data.jobs.find((j) => j.id === 'demo-job-careers')!;
  assert.deepEqual([job.status, job.qa?.pass, job.result?.links], ['done', true, ['https://www.lvlup.vc/careers']]);
  assert.equal(s.data.inbox.find((r) => r.id === 'demo-i-careers')!.status, 'sent');
  assert.equal(s.data.jobActions.find((a) => a.id === 'demo-x-merge')!.status, 'done');
  assert.ok(s.telegram.every((m) => !m.buttons), 'every approval was decided');
  assert.equal(s.telegram.filter((m) => m.decided).length, 4);
  assert.ok(s.data.actions.some((a) => a.action === 'update.done'));
  const ids = s.data.actions.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'unique feed ids');
});

test('demo: steps never change the input state (the player can go back)', () => {
  const a = initialDemo(demoOperator());
  const b = step(a, DEMO_SCRIPT[0]!, 0);
  assert.equal(a.data.inbox.some((r) => r.id === 'demo-i-careers'), false);
  assert.equal(b.data.inbox.some((r) => r.id === 'demo-i-careers'), true);
});
