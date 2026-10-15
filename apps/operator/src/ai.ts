// Which model and how much money one classify + draft may use (pure where possible, tested). Same sources as the worker:
// Admin → API & AI (dashboard) → .env → config/models.yaml. Never a hard-coded model (docs/14): the Anthropic model of
// OPERATOR_MODEL_ROLE comes from claudeModel() (CLAUDE_MODEL_OPERATOR → CLAUDE_MODEL → the role's models → the
// `claude` profile).
import type { ModelRole } from '@rizehubhq/shared';
import { claudeModel, MIN_RUN_BUDGET_USD } from 'worker/src/claude/config';
import type { ModelsConfig } from 'worker/src/models/router';
import type { EffectiveAi } from 'worker/src/settings/runtime';

type Env = Readonly<Record<string, string | undefined>>;

export interface Spend { monthUsd: number; dayUsd: number }

export type Gate = { ok: true; model: string; apiKey: string; capUsd: number } | { ok: false; reason: string };

export function operatorModel(role: ModelRole, cfg: ModelsConfig, env: Env, profile: string): string | null {
  return claudeModel({ id: 'operator', model_role: role }, { env, cfg, profile });
}

/** Can a paid Claude call run now, and with what cap? */
export function gate(o: { env: Env; ai: Pick<EffectiveAi, 'monthlyBudgetUsd' | 'dailyBudgetUsd'>; spend: Spend; model: string | null; maxUsdPerMessage: number }): Gate {
  const apiKey = o.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: 'ANTHROPIC_API_KEY is not set (Admin → API & AI)' };
  if (!o.model) return { ok: false, reason: 'no Anthropic model configured for the operator (config/models.yaml or CLAUDE_MODEL_OPERATOR)' };
  if (!(o.ai.monthlyBudgetUsd > 0)) return { ok: false, reason: 'the monthly AI budget is 0 (Admin → API & AI)' };
  const monthLeft = o.ai.monthlyBudgetUsd - o.spend.monthUsd;
  const dayLeft = o.ai.dailyBudgetUsd && o.ai.dailyBudgetUsd > 0 ? o.ai.dailyBudgetUsd - o.spend.dayUsd : Number.POSITIVE_INFINITY;
  const capUsd = Math.min(o.maxUsdPerMessage, monthLeft, dayLeft);
  if (capUsd < MIN_RUN_BUDGET_USD) {
    return { ok: false, reason: monthLeft <= dayLeft ? 'the monthly AI budget is used up' : 'today\'s AI budget is used up' };
  }
  return { ok: true, model: o.model, apiKey, capUsd: Math.round(capUsd * 100) / 100 };
}
