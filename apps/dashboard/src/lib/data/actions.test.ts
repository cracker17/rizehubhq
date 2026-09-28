import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionExecution } from './actions';

const ap = (payload: Record<string, unknown>, kind: 'external_action' | 'plan' = 'external_action') => ({ kind, payload });

test('agent-proposed actions without a worker executor are manual steps (explicit or legacy payloads)', () => {
  assert.deepEqual(actionExecution(ap({ type: 'external_action', action_type: 'merge_pr', spec: { description: 'Merge acme/theme#7', executor: 'manual' } })),
    { actionType: 'merge_pr', executor: 'manual', spec: 'Merge acme/theme#7' });
  assert.equal(actionExecution(ap({ type: 'external_action', action_type: 'publish_theme', spec: { description: 'x' } })).executor, 'manual', 'older rows without executor');
  assert.equal(actionExecution(ap({ type: 'external_action', action_type: 'rizehub.report_publish', spec: { rizehub: { report_id: 'r1' } } })).executor, 'worker');
  assert.equal(actionExecution(ap({ type: 'question', question: 'x?' })).executor, null);
  assert.equal(actionExecution(ap({ type: 'external_action' }, 'plan')).executor, null);
});
