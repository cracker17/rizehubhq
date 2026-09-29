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

test('markExhausted: 413/404 skip only the failing model for the day; a per-minute 429 only that model for 2 minutes', async () => {
  const { APICallError } = await import('ai');
  const { ModelPicker } = await import('./usage');
  const mk = (statusCode: number) => new APICallError({ message: `HTTP ${statusCode}`, url: 'x', requestBodyValues: {}, statusCode });
  const specs = ['groq:big', 'groq:small', 'google:flash'];
  const cfg = {
    active_profile: 'free', transcription: [], daily_request_caps: { groq: 1000, google: 1000 },
    profiles: { free: { lead: specs, specialist: specs, dev: specs, reports: specs, qa: specs, light: ['groq:small', 'google:flash'] } },
  };
  let now = new Date('2026-09-29T02:00:00Z');
  const picker = new ModelPicker({
    cfg, env: { GROQ_API_KEY: 'g', GOOGLE_GENERATIVE_AI_API_KEY: 'k' }, monthlyBudgetUsd: 0,
    create: async () => ({}) as never, now: () => now,
  });
  const id = async (role: 'writer' | 'light') => { const m = await picker.pick(role); return `${m.provider}:${m.modelId}`; };

  picker.markExhausted('groq', { modelId: 'big', error: mk(413) }); // Groq free tier: request over 8k TPM
  assert.equal(await id('writer'), 'groq:small');
  assert.equal(await id('light'), 'groq:small', 'the rest of Groq stays usable');

  picker.markExhausted('groq', { modelId: 'small', error: mk(429) });
  assert.equal(await id('writer'), 'google:flash');
  assert.equal(await id('light'), 'google:flash');

  now = new Date('2026-09-30T02:00:00Z'); // next Manila day: everything is back
  assert.equal(await id('writer'), 'groq:big');

  picker.markExhausted('groq', { error: mk(413) }); // no model id: falls back to blocking the provider
  assert.equal(await id('writer'), 'google:flash');
});

test('overloaded model (Gemini 503 "high demand", Anthropic 529): fall back, skip only that model for 10 minutes', async () => {
  const { APICallError } = await import('ai');
  const { ModelPicker, TRANSIENT_BLOCK_MS } = await import('./usage');
  const mk = (statusCode: number) => new APICallError({ message: `HTTP ${statusCode}`, url: 'x', requestBodyValues: {}, statusCode });
  for (const s of [500, 502, 503, 504, 529]) assert.equal(isQuotaError(mk(s)), true, String(s));
  const specs = ['google:flash', 'groq:big'];
  const cfg = {
    active_profile: 'free', transcription: [], daily_request_caps: { groq: 1000, google: 1000 },
    profiles: { free: { lead: specs, specialist: specs, dev: specs, reports: specs, qa: specs, light: ['google:lite', 'groq:big'] } },
  };
  let now = new Date('2026-09-29T02:50:00Z');
  const picker = new ModelPicker({
    cfg, env: { GROQ_API_KEY: 'g', GOOGLE_GENERATIVE_AI_API_KEY: 'k' }, monthlyBudgetUsd: 0,
    create: async () => ({}) as never, now: () => now,
  });
  const id = async (role: 'lead' | 'light') => { const m = await picker.pick(role); return `${m.provider}:${m.modelId}`; };
  picker.markExhausted('google', { modelId: 'flash', error: mk(503) });
  assert.equal(await id('lead'), 'groq:big', 'the COO plans on the next model');
  assert.equal(await id('light'), 'google:lite', 'other Google models stay usable');
  now = new Date(now.getTime() + TRANSIENT_BLOCK_MS + 1000);
  assert.equal(await id('lead'), 'google:flash', 'tried again after the skip window');
});

test('429: a daily quota (Gemini free: 20/day per model) skips that model until tomorrow; a per-minute limit for 2 minutes', async () => {
  const { APICallError } = await import('ai');
  const { ModelPicker, RATE_LIMIT_BLOCK_MS, modelBlock } = await import('./usage');
  const rate = (message: string, responseBody?: string) =>
    new APICallError({ message, url: 'x', requestBodyValues: {}, statusCode: 429, responseBody });
  const gemini = rate('You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash',
    '{"error":{"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}');
  const tpm = rate('Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 7900');
  assert.equal(modelBlock(gemini), 'day');
  assert.equal(modelBlock(rate('Rate limit exceeded: free-models-per-day')), 'day', 'OpenRouter free daily cap');
  assert.equal(modelBlock(tpm), RATE_LIMIT_BLOCK_MS);

  const specs = ['google:flash', 'google:lite', 'groq:big'];
  const cfg = {
    active_profile: 'free', transcription: [], daily_request_caps: { google: 40, groq: 1000 },
    profiles: { free: { lead: specs, specialist: specs, dev: specs, reports: specs, qa: specs, light: specs } },
  };
  let now = new Date('2026-09-29T03:36:00Z');
  const picker = new ModelPicker({
    cfg, env: { GROQ_API_KEY: 'g', GOOGLE_GENERATIVE_AI_API_KEY: 'k' }, monthlyBudgetUsd: 0,
    create: async () => ({}) as never, now: () => now,
  });
  const id = async () => { const m = await picker.pick('lead'); return `${m.provider}:${m.modelId}`; };
  picker.markExhausted('google', { modelId: 'flash', error: gemini });
  assert.equal(await id(), 'google:lite', 'the other Gemini model has its own daily quota');
  picker.markExhausted('google', { modelId: 'lite', error: tpm });
  assert.equal(await id(), 'groq:big');
  now = new Date(now.getTime() + RATE_LIMIT_BLOCK_MS + 1000);
  assert.equal(await id(), 'google:lite', 'per-minute limit over');
  now = new Date('2026-09-29T15:00:00Z'); // still 29 Sep in Manila? 23:00 → same day
  picker.markExhausted('google', { modelId: 'lite', error: gemini });
  assert.equal(await id(), 'groq:big');
  now = new Date('2026-09-29T16:30:00Z'); // 00:30 on 30 Sep in Manila
  assert.equal(await id(), 'google:flash', 'daily quotas reset with the Manila day');
});
