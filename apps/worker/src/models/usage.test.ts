import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, costUsd, isQuotaError, normalizeUsage, priceFor } from './usage';

test('prices: Sonnet 5 $2/$10, Haiku 4.5 $1/$5, Opus 5.5 $4/$20; cache write 1.25×, read 0.1× (Opus 0.05×)', () => {
  assert.deepEqual(priceFor('anthropic', 'claude-sonnet-5'), { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 });
  assert.deepEqual(priceFor('anthropic', 'claude-haiku-4-5-20251001'), { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 });
  assert.deepEqual(priceFor('anthropic', 'claude-opus-5-5'), { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 });
  assert.equal(priceFor('google', 'gemini-3.8-flash'), null, 'free tiers cost 0');
  assert.ok(priceFor('openai', 'gpt-5.5'), 'OpenAI has (placeholder) prices');
});

test('Anthropic usage: inputTokens excludes cache reads/writes, so they are added back and priced separately', () => {
  // 1M fresh + 2M cache reads + 1M cache writes + 100k output on Sonnet 5
  const n = normalizeUsage('anthropic', { inputTokens: 1_000_000, cachedInputTokens: 2_000_000, outputTokens: 100_000 },
    { anthropic: { cacheCreationInputTokens: 1_000_000 } });
  assert.deepEqual(n, { inputTokens: 4_000_000, outputTokens: 100_000, cachedInputTokens: 2_000_000, cacheWriteTokens: 1_000_000 });
  // $2 fresh + $0.40 reads + $2.50 writes + $1 output
  assert.equal(costUsd('anthropic', 'claude-sonnet-5', n), 5.9);
  // Haiku: $1 + $0.20 + $1.25 + $0.50
  assert.equal(costUsd('anthropic', 'claude-haiku-4-5-20251001', n), 2.95);
  // no cache metadata → plain input
  assert.equal(costUsd('anthropic', 'claude-sonnet-5', normalizeUsage('anthropic', { inputTokens: 1_000_000, outputTokens: 0 })), 2);
});

test('OpenAI/Google usage already includes cached tokens in inputTokens', () => {
  const n = normalizeUsage('openai', { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 0 });
  assert.deepEqual(n, { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 400_000, cacheWriteTokens: 0 });
  assert.equal(costUsd('openai', 'gpt-5.5', n), 1.28); // 600k × $2 + 400k × $0.20 (placeholder prices)
  assert.equal(costUsd('google', 'gemini-3.8-flash', n), 0);
  assert.deepEqual(addUsage(n, { inputTokens: 5, cacheWriteTokens: 2 }), { inputTokens: 1_000_005, outputTokens: 0, cachedInputTokens: 400_000, cacheWriteTokens: 2 });
});

test('isQuotaError: 429 and 404 (retired model) fall back to the next provider; 400 does not', async () => {
  const { APICallError } = await import('ai');
  const mk = (statusCode: number) => new APICallError({ message: `HTTP ${statusCode}`, url: 'x', requestBodyValues: {}, statusCode });
  assert.equal(isQuotaError(mk(429)), true);
  assert.equal(isQuotaError(mk(404)), true);
  assert.equal(isQuotaError(mk(413)), true);
  assert.equal(isQuotaError(mk(400)), false);
});
