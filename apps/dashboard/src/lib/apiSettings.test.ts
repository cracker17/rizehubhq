import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDashboardAi, PROVIDER_KEYS } from '@rizehubhq/shared';
import { formFromDashboard, keyState, parseAiForm, raisesBudget, usdOrNone } from './apiSettings';

test('keyState: a stored key wins; otherwise what the worker reports; offline worker = unknown', () => {
  assert.equal(keyState(true, 'dashboard', false), 'dashboard');
  assert.equal(keyState(true, null, false), 'dashboard', 'stored even when the worker is offline');
  assert.equal(keyState(true, 'env', true), 'dashboard_unreadable');
  assert.equal(keyState(false, 'env', false), 'env');
  assert.equal(keyState(false, 'missing', false), 'missing');
  assert.equal(keyState(false, null, false), 'unknown');
  assert.equal(keyState(false, 'dashboard', false), 'unknown', 'just removed, worker not reloaded yet');
});

test('parseAiForm: empty = use .env; amounts in USD; per-role models must be provider:model', () => {
  assert.deepEqual(parseAiForm({ profile: '', monthly: '', daily: '', modelIds: {} }),
    { ok: true, value: { profile: null, monthly: null, daily: null, modelIds: {} } });
  assert.deepEqual(parseAiForm({ profile: 'hybrid', monthly: '$1,250.555', daily: '0', modelIds: { qa: ' openai:gpt-5.5 ', dev: '' } }),
    { ok: true, value: { profile: 'hybrid', monthly: 1250.56, daily: 0, modelIds: { qa: 'openai:gpt-5.5' } } });
  assert.deepEqual(parseAiForm({ profile: '', monthly: '', daily: '', modelIds: { lead: 'openrouter:qwen/qwen3.8-27b:free' } }).ok, true);
  const bad = [
    { profile: 'turbo', monthly: '', daily: '', modelIds: {} },
    { profile: '', monthly: '-5', daily: '', modelIds: {} },
    { profile: '', monthly: 'ten', daily: '', modelIds: {} },
    { profile: '', monthly: '', daily: '200000', modelIds: {} },
    { profile: '', monthly: '', daily: '', modelIds: { qa: 'gpt-5.5' } },
    { profile: '', monthly: '', daily: '', modelIds: { qa: 'mistral:large' } },
  ];
  for (const f of bad) assert.equal(parseAiForm(f).ok, false, JSON.stringify(f));
  const msg = parseAiForm({ profile: '', monthly: '', daily: '', modelIds: { qa: 'gpt-5.5' } });
  assert.match(!msg.ok ? msg.error : '', /QA reviews: use provider:model/);
});

test('formFromDashboard round-trips and raisesBudget mirrors the SQL 2FA rule', () => {
  const d = parseDashboardAi({ ai_model_profile: 'claude', ai_monthly_budget_usd: 20, ai_daily_budget_usd: 2, ai_model_ids: { qa: 'openai:gpt-5.5' } });
  const f = formFromDashboard(d);
  assert.deepEqual(f, { profile: 'claude', monthly: '20', daily: '2', modelIds: { qa: 'openai:gpt-5.5' } });
  const same = parseAiForm(f);
  assert.ok(same.ok);
  if (!same.ok) return;
  assert.equal(raisesBudget(d, same.value), false);
  assert.equal(raisesBudget(d, { ...same.value, monthly: 10, daily: 1 }), false, 'lowering');
  assert.equal(raisesBudget(d, { ...same.value, monthly: 25 }), true);
  assert.equal(raisesBudget(d, { ...same.value, daily: 0 }), true, '0 = no daily cap');
  assert.equal(raisesBudget(d, { ...same.value, monthly: null }), true, 'back to the .env value');
});

test('every provider key has a label, a hint and an https docs link; usdOrNone formats', () => {
  for (const k of PROVIDER_KEYS) {
    assert.ok(k.label && k.hint, k.name);
    assert.match(k.docs, /^https:\/\//, k.name);
  }
  assert.equal(usdOrNone(null, 'no cap'), 'no cap');
  assert.equal(usdOrNone(1250.5, '-'), '$1,250.5');
  assert.equal(usdOrNone(0, '-'), '$0');
});
