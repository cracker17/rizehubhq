import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { ANTHROPIC_CACHE, cachedPrompt, withRollingCache } from './cache';

test('cachedPrompt: Anthropic gets a cached system message; other providers keep system + prompt', () => {
  assert.deepEqual(cachedPrompt('openai', 'SYS', 'hello'), { system: 'SYS', prompt: 'hello' });
  assert.deepEqual(cachedPrompt('google', 'SYS', 'hello'), { system: 'SYS', prompt: 'hello' });
  assert.deepEqual(cachedPrompt('anthropic', 'SYS', 'hello'), {
    messages: [
      { role: 'system', content: 'SYS', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
      { role: 'user', content: 'hello' },
    ],
  });
});

test('withRollingCache: only the newest message carries the conversation breakpoint (Anthropic only)', () => {
  const msgs: ModelMessage[] = [
    { role: 'system', content: 'SYS', providerOptions: ANTHROPIC_CACHE },
    { role: 'user', content: 'task', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } }, other: { x: 1 } } },
    { role: 'assistant', content: 'working' },
  ];
  const out = withRollingCache('anthropic', msgs);
  assert.deepEqual(out[0], msgs[0], 'system breakpoint kept');
  assert.deepEqual(out[1]!.providerOptions, { other: { x: 1 } }, 'older rolling breakpoint removed');
  assert.deepEqual(out[2]!.providerOptions, ANTHROPIC_CACHE);
  assert.equal(withRollingCache('openai', msgs), msgs);
  assert.deepEqual(withRollingCache('anthropic', []), []);
});
