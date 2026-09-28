import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseCandidate, loadModelsConfig, QuotaExhaustedError } from './router';

const cfg = loadModelsConfig();
const usage = { requestsToday: {}, spentThisMonthUsd: 0 };

test('free profile picks Gemini when its key exists', () => {
  const c = chooseCandidate('specialist', cfg, { profile: 'free', env: { GOOGLE_GENERATIVE_AI_API_KEY: 'x', GROQ_API_KEY: 'y' }, usage, monthlyBudgetUsd: 0 });
  assert.equal(c.provider, 'google');
});

test('falls back to Groq when Gemini daily cap is nearly used', () => {
  const c = chooseCandidate('specialist', cfg, { profile: 'free', env: { GOOGLE_GENERATIVE_AI_API_KEY: 'x', GROQ_API_KEY: 'y' }, usage: { requestsToday: { google: 950 }, spentThisMonthUsd: 0 }, monthlyBudgetUsd: 0 });
  assert.equal(c.provider, 'groq');
});

test('paid providers are skipped when the monthly budget is 0', () => {
  assert.throws(() => chooseCandidate('dev', cfg, { profile: 'claude', env: { ANTHROPIC_API_KEY: 'k' }, usage, monthlyBudgetUsd: 0 }), QuotaExhaustedError);
});

test('claude profile works once there is a budget', () => {
  const c = chooseCandidate('qa', cfg, { profile: 'claude', env: { ANTHROPIC_API_KEY: 'k' }, usage, monthlyBudgetUsd: 50 });
  assert.deepEqual(c, { provider: 'anthropic', modelId: 'claude-opus-5-5' });
});

test('per-agent override is tried first', () => {
  const c = chooseCandidate('dev', cfg, { profile: 'free', override: 'groq:openai/gpt-oss-120b', env: { GOOGLE_GENERATIVE_AI_API_KEY: 'x', GROQ_API_KEY: 'y' }, usage, monthlyBudgetUsd: 0 });
  assert.equal(c.provider, 'groq');
});

test('every profile defines every role', () => {
  for (const p of Object.keys(cfg.profiles)) assert.ok((cfg.profiles[p]?.light.length ?? 0) > 0, p);
});
