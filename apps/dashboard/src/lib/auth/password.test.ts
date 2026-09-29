import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD_MIN, passwordProblem, recoveryFresh } from './password';
import { rateLimited, type Tries } from './rateLimit';

const NOW = 1_790_000_000;

test('passwordProblem: length, byte cap, repetition, reuse and the email name', () => {
  assert.match(passwordProblem('short')!, new RegExp(`${PASSWORD_MIN}`));
  assert.equal(passwordProblem('correct horse battery'), null);
  assert.match(passwordProblem('a'.repeat(73))!, /at most 72/);
  assert.match(passwordProblem('😀'.repeat(19))!, /at most 72/, '19 emoji = 76 bytes');
  assert.match(passwordProblem('zzzzzzzzzzzzzz')!, /repetitive/);
  assert.match(passwordProblem('same old password', { current: 'same old password' })!, /different/);
  assert.match(passwordProblem('Talentedhand10-2026!', { email: 'talentedhand10@gmail.com' })!, /email name/);
  assert.equal(passwordProblem('a long unrelated phrase', { email: 'ceo@x.ph' }), null, 'short email names are not checked');
});

test('recoveryFresh: only a recovery sign-in from the last 15 minutes counts', () => {
  assert.equal(recoveryFresh([{ method: 'recovery', timestamp: NOW - 60 }], NOW), true);
  assert.equal(recoveryFresh([{ method: 'recovery', timestamp: NOW - 16 * 60 }], NOW), false);
  assert.equal(recoveryFresh([{ method: 'password', timestamp: NOW }, { method: 'totp', timestamp: NOW }], NOW), false);
  assert.equal(recoveryFresh([{ method: 'recovery', timestamp: NOW + 3600 }], NOW), false, 'future timestamps are ignored');
  assert.equal(recoveryFresh(null, NOW), false);
});

test('rateLimited: allows max attempts per window, then blocks until the window resets', () => {
  const m: Tries = new Map();
  const results = Array.from({ length: 4 }, () => rateLimited(m, 'ceo', 3, 1000, 0));
  assert.deepEqual(results, [false, false, false, true]);
  assert.equal(rateLimited(m, 'other', 3, 1000, 0), false, 'keys are separate');
  assert.equal(rateLimited(m, 'ceo', 3, 1000, 1000), false, 'new window');
});
