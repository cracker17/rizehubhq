import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrammyError } from 'grammy';
import { conflictBackoffMs, HEALTHY_RUN_MS, isPollConflict, pollWithRetry } from './polling';

const conflict = () => new GrammyError("Call to 'getUpdates' failed!", { ok: false, error_code: 409,
  description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' }, 'getUpdates', {});

test('isPollConflict: only a 409 GrammyError', () => {
  assert.equal(isPollConflict(conflict()), true);
  assert.equal(isPollConflict(new GrammyError('x', { ok: false, error_code: 401, description: 'Unauthorized' }, 'getMe', {})), false);
  assert.equal(isPollConflict(new Error('409')), false);
});

test('conflictBackoffMs: 30 s doubling, capped at 5 minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(conflictBackoffMs), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
});

test('pollWithRetry: retries 409s with backoff, then returns when polling ends normally', async () => {
  const waits: number[] = [];
  const logs: string[] = [];
  let calls = 0;
  await pollWithRetry({
    start: async () => { calls += 1; if (calls <= 3) throw conflict(); },
    sleep: async (ms) => { waits.push(ms); },
    now: () => 0,
    log: (m) => logs.push(m),
  });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [30_000, 60_000, 120_000]);
  assert.equal(logs.length, 3);
  assert.match(logs[0]!, /409 Conflict/);
});

test('pollWithRetry: any other error is rethrown (a bad token must still fail loudly)', async () => {
  const bad = new GrammyError('x', { ok: false, error_code: 401, description: 'Unauthorized' }, 'getMe', {});
  await assert.rejects(pollWithRetry({ start: async () => { throw bad; }, sleep: async () => {} }), bad);
});

test('pollWithRetry: a long healthy run resets the backoff', async () => {
  let t = 0;
  const waits: number[] = [];
  let calls = 0;
  await pollWithRetry({
    start: async () => {
      calls += 1;
      if (calls === 1) throw conflict();                 // immediate conflict → 30 s
      if (calls === 2) { t += HEALTHY_RUN_MS; throw conflict(); } // ran 10 min, then conflict → back to 30 s
    },
    sleep: async (ms) => { waits.push(ms); },
    now: () => t,
  });
  assert.deepEqual(waits, [30_000, 30_000]);
});

test('pollWithRetry: stops retrying once shutdown is requested', async () => {
  let stopped = false;
  let calls = 0;
  await pollWithRetry({
    start: async () => { calls += 1; throw conflict(); },
    sleep: async () => { stopped = true; },
    stopped: () => stopped,
  });
  assert.equal(calls, 1);
});
