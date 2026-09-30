import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubHookHeaders } from './brainHook';

test('only GitHub webhook headers pass through to the brain', () => {
  const h = new Headers({
    'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': 'abc-123',
    'x-hub-signature-256': 'sha256=deadbeef', cookie: 'sb-access-token=secret', authorization: 'Bearer x',
    'x-forwarded-for': '1.2.3.4', 'x-brain-secret': 'spoofed',
  });
  assert.deepEqual(githubHookHeaders(h), {
    'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': 'abc-123', 'x-hub-signature-256': 'sha256=deadbeef',
  });
  assert.deepEqual(githubHookHeaders(new Headers({ 'x-github-event': 'x'.repeat(500) })), {}, 'oversized values are dropped');
});
