// /budget shows the same caps the worker enforces: dashboard (Admin → API & AI) → .env → default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetCaps } from './budget';

test('budgetCaps: the dashboard value wins, .env is the default, older settings.daily_budget_usd comes last', () => {
  const env = { monthlyBudgetUsd: 50, dailyBudgetUsd: 5 };
  assert.deepEqual(budgetCaps(env, {}), { monthly: 50, daily: 5 });
  assert.deepEqual(budgetCaps(env, { ai_monthly_budget_usd: 20, ai_daily_budget_usd: 2 }), { monthly: 20, daily: 2 });
  assert.deepEqual(budgetCaps(env, { ai_daily_budget_usd: 0 }), { monthly: 50, daily: null }, 'dashboard 0 = no daily cap');
  assert.deepEqual(budgetCaps({ monthlyBudgetUsd: null, dailyBudgetUsd: null }, { daily_budget_usd: 10, monthly_budget_usd: 99 }), { monthly: 0, daily: 10 },
    'monthly_budget_usd (seed row) is not a cap: the worker never read it');
  assert.deepEqual(budgetCaps({ monthlyBudgetUsd: null, dailyBudgetUsd: 0 }, { daily_budget_usd: 10 }), { monthly: 0, daily: null }, '.env 0 = no cap');
});
