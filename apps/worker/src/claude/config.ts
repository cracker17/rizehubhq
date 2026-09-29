// Claude Agent SDK runtime configuration (docs/05 "Claude runtime"). Values come from workerEnv() (the frozen startup
// snapshot: ANTHROPIC_API_KEY is a secret and leaves process.env at startup).
//
//   CLAUDE_RUNTIME_ENABLED=true|false   master switch (default false): off → every `runtime: claude` agent runs on the
//                                       built-in runner
//   ANTHROPIC_API_KEY                   Anthropic Console API key (the Agent SDK must not use a claude.ai login)
//   MONTHLY_BUDGET_USD > 0              paid spend allowed at all; DAILY_AI_BUDGET_USD caps the day
//   CLAUDE_MODEL / CLAUDE_MODEL_<AGENT> optional model id; else the role's Anthropic model from config/models.yaml
//   CLAUDE_FILE_TOOLS=hq|native         hq (default): files through HQ's workspace_fs over MCP (race-safe jail);
//                                       native: Claude Code's Read/Edit/Write/Glob/Grep, confined to the task workspace
//   CLAUDE_TIMEOUT_MS                   max wait for one run (default 30 min)
//   CLAUDE_HQ_MCP_URL                   the worker's own MCP endpoint (default http://127.0.0.1:<WORKER_HTTP_PORT>/mcp)
import { config, workerEnv } from '../config';
import { parseCandidate, profileSpecs, roleSpecs, type ModelsConfig } from '../models/router';
import type { Role } from '../roles';
import { envSuffix } from '../hermes/config';

type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_CLAUDE_TIMEOUT_MS = 30 * 60_000;
/** Below this much budget left, a run is not worth starting (falls back to the built-in runner instead). */
export const MIN_RUN_BUDGET_USD = 0.05;

const truthy = (v: string | undefined) => ['1', 'true', 'on', 'yes'].includes((v ?? '').trim().toLowerCase());

/** CLAUDE_RUNTIME_ENABLED: off unless 1 / true / on / yes. */
export function claudeRuntimeEnabled(env: Env = workerEnv()): boolean {
  return truthy(env.CLAUDE_RUNTIME_ENABLED);
}

export type ClaudeFileTools = 'hq' | 'native';
/** CLAUDE_FILE_TOOLS: native only when set to exactly that; everything else is hq. */
export function claudeFileTools(env: Env = workerEnv()): ClaudeFileTools {
  return (env.CLAUDE_FILE_TOOLS ?? '').trim().toLowerCase() === 'native' ? 'native' : 'hq';
}

export function claudeTimeoutMs(env: Env = workerEnv()): number {
  const n = Number(env.CLAUDE_TIMEOUT_MS);
  return env.CLAUDE_TIMEOUT_MS?.trim() && Number.isInteger(n) && n > 0 ? n : DEFAULT_CLAUDE_TIMEOUT_MS;
}

/** The worker's own HQ MCP endpoint as seen from inside the worker container. */
export function hqMcpUrl(env: Env = workerEnv()): string {
  const u = env.CLAUDE_HQ_MCP_URL?.trim();
  return u ? u.replace(/\/+$/, '') : `http://127.0.0.1:${config.httpPort}/mcp`;
}

const bareAnthropic = (spec: string): string | null => {
  const s = spec.trim();
  if (!s) return null;
  if (!s.includes(':')) return /^claude-/.test(s) ? s : null;
  try {
    const c = parseCandidate(s);
    return c.provider === 'anthropic' ? c.modelId : null;
  } catch { return null; }
};

/**
 * The Anthropic model a Claude run uses (never hard-coded, docs/14): CLAUDE_MODEL_<AGENT> → CLAUDE_MODEL → the first
 * Anthropic model of the role's usual order (agent model_override → MODEL_ID_<ROLE> → active profile) → the role in the
 * `claude` profile of config/models.yaml. null = no Anthropic model configured.
 */
export function claudeModel(
  role: Pick<Role, 'id' | 'model_role'>,
  o: { env?: Env; cfg: ModelsConfig; profile?: string; override?: string | null },
): string | null {
  const env = o.env ?? workerEnv();
  for (const v of [env[`CLAUDE_MODEL_${envSuffix(role.id)}`], env.CLAUDE_MODEL]) {
    const m = v ? bareAnthropic(v) : null;
    if (m) return m;
  }
  let specs: string[] = [];
  try { specs = roleSpecs(role.model_role, o.cfg, { profile: o.profile, env, override: o.override ?? null }); } catch { /* unknown profile */ }
  const claudeProfile = o.cfg.profiles.claude;
  if (claudeProfile) specs = [...specs, ...profileSpecs(claudeProfile, role.model_role)];
  for (const s of specs) {
    const m = bareAnthropic(s);
    if (m) return m;
  }
  return null;
}

/**
 * One startup line on the `runtime: claude` agents (index.ts). Nothing is configured by default: those agents then run
 * on the built-in runner.
 */
export function claudeStartupReport(
  roles: readonly { id: string; runtime: string }[],
  env: Env = workerEnv(),
  monthlyBudgetUsd = config.monthlyBudgetUsd,
): { line: string; warnings: string[] } {
  const ids = roles.filter((r) => r.runtime === 'claude').map((r) => r.id);
  const enabled = claudeRuntimeEnabled(env);
  const key = !!env.ANTHROPIC_API_KEY?.trim();
  const warnings: string[] = [];
  const missing = [!enabled && 'CLAUDE_RUNTIME_ENABLED is off', !key && 'ANTHROPIC_API_KEY not set', !(monthlyBudgetUsd > 0) && 'MONTHLY_BUDGET_USD is 0']
    .filter(Boolean) as string[];
  if (ids.length && missing.length) warnings.push(`[worker] runtime:claude agents ${ids.join(', ')} run on the built-in runner: ${missing.join(', ')}`);
  const state = !ids.length ? 'none' : missing.length ? `on the built-in runner (${missing.join(', ')}): ${ids.join(', ')}` : `on Claude: ${ids.join(', ')}`;
  return { line: `[worker] runtime:claude agents ${state} · file tools ${claudeFileTools(env)}`, warnings };
}
