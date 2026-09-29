import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseCandidate, createModel, hasFreeProviderKey, isPaidSpec, loadModelsConfig, MODEL_PROFILES, QuotaExhaustedError, roleEnvVar, roleSpecs } from './router';

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
  for (const p of Object.keys(cfg.profiles)) {
    for (const r of ['lead', 'specialist', 'dev', 'design', 'writer', 'sales', 'reports', 'qa', 'light'] as const) assert.ok((cfg.profiles[p]?.[r]?.length ?? 0) > 0, `${p}.${r}`);
  }
});

// ---------- paid profile + env overrides (six-agent roster, docs/14) ----------
const paidEnv = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' };

test('paid profile: lead/dev/sales → Sonnet, design/writer/light → Haiku, QA → OpenAI', () => {
  const pick = (role: Parameters<typeof chooseCandidate>[0]) =>
    chooseCandidate(role, cfg, { profile: 'paid', env: paidEnv, usage, monthlyBudgetUsd: 50 });
  for (const r of ['lead', 'dev', 'sales'] as const) assert.deepEqual(pick(r), { provider: 'anthropic', modelId: 'claude-sonnet-5' }, r);
  for (const r of ['design', 'writer', 'light'] as const) assert.deepEqual(pick(r), { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' }, r);
  assert.equal(pick('qa').provider, 'openai');
  // QA falls back to Sonnet only when OpenAI is unavailable
  assert.deepEqual(chooseCandidate('qa', cfg, { profile: 'paid', env: { ANTHROPIC_API_KEY: 'a' }, usage, monthlyBudgetUsd: 50 }),
    { provider: 'anthropic', modelId: 'claude-sonnet-5' });
});

test('MODEL_ID_<ROLE> env overrides win over the file; the agent override still comes first', () => {
  const env = { ...paidEnv, MODEL_ID_WRITER: 'anthropic:claude-sonnet-5', MODEL_ID_QA: 'openai:gpt-5.4', MODEL_ID_LIGHT: ' anthropic:claude-haiku-4-5-20251001 ' };
  assert.deepEqual(chooseCandidate('writer', cfg, { profile: 'paid', env, usage, monthlyBudgetUsd: 50 }), { provider: 'anthropic', modelId: 'claude-sonnet-5' });
  assert.deepEqual(chooseCandidate('qa', cfg, { profile: 'paid', env, usage, monthlyBudgetUsd: 50 }), { provider: 'openai', modelId: 'gpt-5.4' });
  assert.deepEqual(roleSpecs('qa', cfg, { profile: 'paid', env }), ['openai:gpt-5.4', 'openai:gpt-5.5', 'anthropic:claude-sonnet-5']);
  assert.deepEqual(roleSpecs('light', cfg, { profile: 'paid', env }), ['anthropic:claude-haiku-4-5-20251001'], 'de-duplicated and trimmed');
  assert.deepEqual(chooseCandidate('writer', cfg, { profile: 'paid', env, usage, monthlyBudgetUsd: 50, override: 'openai:gpt-5.4-mini' }),
    { provider: 'openai', modelId: 'gpt-5.4-mini' });
  // an env override works on the free profile too (key present, budget allows)
  assert.deepEqual(chooseCandidate('dev', cfg, { profile: 'free', env: { ...env, MODEL_ID_DEV: 'anthropic:claude-sonnet-5' }, usage, monthlyBudgetUsd: 10 }),
    { provider: 'anthropic', modelId: 'claude-sonnet-5' });
  assert.equal(roleEnvVar('design'), 'MODEL_ID_DESIGN');
  assert.throws(() => chooseCandidate('dev', cfg, { profile: 'paid', env: { ...paidEnv, MODEL_ID_DEV: 'sonnet' }, usage, monthlyBudgetUsd: 50 }), /Bad model spec "sonnet"/);
});

test('daily AI budget reached (paidBlocked): paid providers stop, the free profile takes over when its keys exist', () => {
  const env = { ...paidEnv, GROQ_API_KEY: 'g' };
  assert.deepEqual(chooseCandidate('dev', cfg, { profile: 'paid', env, usage, monthlyBudgetUsd: 50, paidBlocked: true }),
    { provider: 'groq', modelId: 'openai/gpt-oss-120b' });
  // env and agent overrides that point at paid models are skipped too
  assert.equal(chooseCandidate('qa', cfg, { profile: 'paid', env: { ...env, MODEL_ID_QA: 'openai:gpt-5.4' }, usage, monthlyBudgetUsd: 50, paidBlocked: true, override: 'anthropic:claude-sonnet-5' }).provider, 'groq');
  // no free keys → nothing usable: the caller waits (QuotaExhaustedError) and the reason says why
  assert.throws(() => chooseCandidate('writer', cfg, { profile: 'paid', env: paidEnv, usage, monthlyBudgetUsd: 50, paidBlocked: true }),
    (e: unknown) => e instanceof QuotaExhaustedError && /daily AI budget reached/.test(e.message));
  // not blocked: the paid profile never silently falls back to free models
  assert.throws(() => chooseCandidate('dev', cfg, { profile: 'paid', env: { GROQ_API_KEY: 'g' }, usage, monthlyBudgetUsd: 50 }), QuotaExhaustedError);
  assert.equal(hasFreeProviderKey(env), true);
  assert.equal(hasFreeProviderKey({ ...paidEnv, GOOGLE_GENERATIVE_AI_API_KEY: '  ' }), false);
});

test('roles missing from an older profile fall back to specialist; unknown profile throws', () => {
  const old = { ...cfg, profiles: { legacy: { ...cfg.profiles.free!, design: undefined, writer: undefined, sales: undefined } } };
  assert.deepEqual(roleSpecs('sales', old, { profile: 'legacy', env: {} }), cfg.profiles.free!.specialist);
  assert.throws(() => roleSpecs('dev', cfg, { profile: 'nope', env: {} }), /Unknown model profile "nope"/);
  for (const p of MODEL_PROFILES) assert.ok(cfg.profiles[p], `profile ${p} exists in config/models.yaml`);
});

// ---------- Kimi (moonshot) backup + paid OpenRouter (docs/15 §7, M13.1) ----------
const ALL_ROLES = ['lead', 'specialist', 'dev', 'design', 'writer', 'sales', 'reports', 'qa', 'light'] as const;

test('isPaidSpec: anthropic, openai, moonshot and OpenRouter without :free are paid', () => {
  assert.equal(isPaidSpec('moonshot', 'kimi-k2.6'), true);
  assert.equal(isPaidSpec('anthropic', 'claude-sonnet-5'), true);
  assert.equal(isPaidSpec('openrouter', 'anthropic/claude-sonnet-5'), true);
  assert.equal(isPaidSpec('openrouter', 'qwen/qwen3.8-27b:free'), false);
  assert.equal(isPaidSpec('google', 'gemini-3.8-flash'), false);
  assert.equal(isPaidSpec('groq', 'openai/gpt-oss-120b'), false);
  assert.equal(hasFreeProviderKey({ MOONSHOT_API_KEY: 'm' }), false, 'Kimi alone is not a free fallback');
});

test('free profile: moonshot:kimi-k2.6 is the LAST entry of every role', () => {
  for (const r of ALL_ROLES) {
    const list = cfg.profiles.free![r]!;
    assert.equal(list.at(-1), 'moonshot:kimi-k2.6', r);
    assert.equal(list.filter((s) => s.startsWith('moonshot:')).length, 1, r);
  }
});

test('moonshot needs MOONSHOT_API_KEY and a monthly budget > 0', () => {
  const env = { MOONSHOT_API_KEY: 'm' };
  assert.deepEqual(chooseCandidate('lead', cfg, { profile: 'free', env, usage, monthlyBudgetUsd: 10 }), { provider: 'moonshot', modelId: 'kimi-k2.6' });
  assert.throws(() => chooseCandidate('lead', cfg, { profile: 'free', env, usage, monthlyBudgetUsd: 0 }),
    (e: unknown) => e instanceof QuotaExhaustedError && /moonshot:kimi-k2\.6: monthly budget reached/.test(e.message));
  assert.throws(() => chooseCandidate('lead', cfg, { profile: 'free', env: {}, usage, monthlyBudgetUsd: 10 }),
    (e: unknown) => e instanceof QuotaExhaustedError && /moonshot:kimi-k2\.6: no MOONSHOT_API_KEY/.test(e.message));
  // month's spend used up → skipped like any paid model
  assert.throws(() => chooseCandidate('lead', cfg, { profile: 'free', env, usage: { requestsToday: {}, spentThisMonthUsd: 10 }, monthlyBudgetUsd: 10 }), QuotaExhaustedError);
});

test('free profile: Kimi only runs once every free model is unavailable', () => {
  const env = { GOOGLE_GENERATIVE_AI_API_KEY: 'x', GROQ_API_KEY: 'y', OPENROUTER_API_KEY: 'o', MOONSHOT_API_KEY: 'm' };
  assert.equal(chooseCandidate('dev', cfg, { profile: 'free', env, usage, monthlyBudgetUsd: 10 }).provider, 'google', 'free models first');
  const freeSpecs = cfg.profiles.free!.dev!.filter((s) => !s.startsWith('moonshot:'));
  const outage = { requestsToday: {}, spentThisMonthUsd: 0, blockedModels: new Set(freeSpecs) };
  assert.deepEqual(chooseCandidate('dev', cfg, { profile: 'free', env, usage: outage, monthlyBudgetUsd: 10 }), { provider: 'moonshot', modelId: 'kimi-k2.6' });
  // budget 0: Kimi is skipped even in an outage
  assert.throws(() => chooseCandidate('dev', cfg, { profile: 'free', env, usage: outage, monthlyBudgetUsd: 0 }), QuotaExhaustedError);
  // daily AI budget reached: paid models stop, Kimi included
  assert.throws(() => chooseCandidate('dev', cfg, { profile: 'free', env, usage: outage, monthlyBudgetUsd: 10, paidBlocked: true }),
    (e: unknown) => e instanceof QuotaExhaustedError && /moonshot:kimi-k2\.6: daily AI budget reached/.test(e.message));
});

test('OpenRouter without :free is paid (budget-gated); :free models stay free', () => {
  const env = { OPENROUTER_API_KEY: 'o', GROQ_API_KEY: 'g' };
  const paidOr = 'openrouter:anthropic/claude-sonnet-5';
  // budget 0: the paid OpenRouter override is skipped, the profile's free models take over
  assert.equal(chooseCandidate('dev', cfg, { profile: 'free', env, usage, monthlyBudgetUsd: 0, override: paidOr }).provider, 'groq');
  assert.deepEqual(chooseCandidate('dev', cfg, { profile: 'free', env, usage, monthlyBudgetUsd: 10, override: paidOr }),
    { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-5' });
  assert.equal(chooseCandidate('dev', cfg, { profile: 'free', env, usage, monthlyBudgetUsd: 10, override: paidOr, paidBlocked: true }).provider, 'groq',
    'the daily AI budget stops paid OpenRouter models too');
  assert.deepEqual(chooseCandidate('dev', cfg, { profile: 'free', env, usage, monthlyBudgetUsd: 0, override: 'openrouter:qwen/qwen3.8-27b:free' }),
    { provider: 'openrouter', modelId: 'qwen/qwen3.8-27b:free' });
});

test('kimi profile: lead + QA on kimi-k3, every other role on kimi-k2.6', () => {
  const env = { MOONSHOT_API_KEY: 'm' };
  for (const r of ALL_ROLES) {
    const c = chooseCandidate(r, cfg, { profile: 'kimi', env, usage, monthlyBudgetUsd: 20 });
    assert.deepEqual(c, { provider: 'moonshot', modelId: r === 'lead' || r === 'qa' ? 'kimi-k3' : 'kimi-k2.6' }, r);
  }
  assert.throws(() => chooseCandidate('lead', cfg, { profile: 'kimi', env, usage, monthlyBudgetUsd: 0 }), QuotaExhaustedError);
  assert.ok(MODEL_PROFILES.includes('kimi'));
});

test('createModel(moonshot): OpenAI-compatible chat model (chat/completions, not the Responses API)', async () => {
  const m = await createModel({ provider: 'moonshot', modelId: 'kimi-k2.6' }, { MOONSHOT_API_KEY: 'm' });
  assert.ok(typeof m === 'object');
  assert.equal(m.modelId, 'kimi-k2.6');
  assert.equal(m.provider, 'moonshot.chat');
});
