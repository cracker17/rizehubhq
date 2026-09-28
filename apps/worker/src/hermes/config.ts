// Hermes Agent runtime configuration (docs/05 "Hermes runtime"). Every value comes from workerEnv(): the URL/key
// pairs and the MCP tokens are secrets (config.ts SECRET_ENV) and leave process.env at startup.
//
//   HERMES_URL_<AGENT> / HERMES_KEY_<AGENT>   the agent's Hermes API server (key = its API_SERVER_KEY)
//   HQ_MCP_TOKEN_<AGENT>                      bearer token that agent's Hermes sends to the worker's /mcp endpoint
//   HERMES_FALLBACK=on|off                    run on the built-in AI SDK runner when Hermes is unavailable (default on)
//   HERMES_TIMEOUT_MS                         max wait for one Hermes task run (default 30 min)
//   HERMES_MODEL / HERMES_MODEL_<AGENT>       the model id Hermes runs (config.yaml); the worker prices usage with it
// <AGENT> = agent id upper-cased with "-" → "_": web-dev → WEB_DEV, designer → DESIGNER, writer → WRITER, sales → SALES.
import { workerEnv } from '../config';

type Env = Readonly<Record<string, string | undefined>>;

/** Agents whose roster runtime is `hermes` (agents/roster.yaml). Deploy templates exist for exactly these. */
export const HERMES_AGENTS = ['web-dev', 'designer', 'writer', 'sales'] as const;

/** web-dev → WEB_DEV */
export const envSuffix = (agentId: string) => agentId.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

export const DEFAULT_HERMES_TIMEOUT_MS = 30 * 60_000;
/** Shorter than this is treated as "not configured" for MCP tokens (openssl rand -hex 32 gives 64). */
export const MIN_MCP_TOKEN_LENGTH = 32;

export interface HermesAgentConfig {
  agentId: string;
  /** Base URL of the Hermes API server, e.g. http://hermes-web-dev:8642 (no trailing slash). */
  url: string;
  /** Hermes API_SERVER_KEY (Bearer). */
  key: string;
  timeoutMs: number;
  /** Model id Hermes is configured with (for cost records), or null. */
  model: string | null;
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The agent's Hermes instance, or null when HERMES_URL_<AGENT> or HERMES_KEY_<AGENT> is empty. */
export function hermesAgentConfig(agentId: string, env: Env = workerEnv()): HermesAgentConfig | null {
  const s = envSuffix(agentId);
  const url = env[`HERMES_URL_${s}`]?.trim();
  const key = env[`HERMES_KEY_${s}`]?.trim();
  if (!url || !key) return null;
  const model = env[`HERMES_MODEL_${s}`]?.trim() || env.HERMES_MODEL?.trim() || null;
  return { agentId, url: url.replace(/\/+$/, ''), key, timeoutMs: positiveInt(env.HERMES_TIMEOUT_MS, DEFAULT_HERMES_TIMEOUT_MS), model };
}

/** HERMES_FALLBACK: on (default) unless off / false / 0 / no. */
export function hermesFallbackEnabled(env: Env = workerEnv()): boolean {
  return !['off', 'false', '0', 'no'].includes((env.HERMES_FALLBACK ?? 'on').trim().toLowerCase());
}

/** token → agent id for every agent with a usable HQ_MCP_TOKEN_<AGENT>. Duplicate tokens are dropped (ambiguous). */
export function mcpTokenMap(agentIds: readonly string[], env: Env = workerEnv()): Map<string, string> {
  const out = new Map<string, string>();
  const dup = new Set<string>();
  for (const id of agentIds) {
    const t = env[`HQ_MCP_TOKEN_${envSuffix(id)}`]?.trim();
    if (!t || t.length < MIN_MCP_TOKEN_LENGTH) continue;
    if (out.has(t)) dup.add(t);
    out.set(t, id);
  }
  for (const t of dup) out.delete(t);
  return out;
}

/**
 * One startup line on how the `runtime: hermes` agents will run, plus warnings for half-configured agents (index.ts).
 * Nothing configured → those agents simply run on the built-in runner (or are re-queued/failed with HERMES_FALLBACK=off).
 */
export function hermesStartupReport(roles: readonly { id: string; runtime: string }[], env: Env = workerEnv()): { line: string; warnings: string[] } {
  const hermesRoles = roles.filter((r) => r.runtime === 'hermes').map((r) => r.id);
  const fallback = hermesFallbackEnabled(env);
  const withToken = new Set(mcpTokenMap(hermesRoles, env).values());
  const on: string[] = [];
  const warnings: string[] = [];
  for (const id of hermesRoles) {
    const s = envSuffix(id);
    const cfg = hermesAgentConfig(id, env);
    if (cfg) {
      on.push(id);
      if (!withToken.has(id)) {
        warnings.push(`[worker] Hermes ${id}: HQ_MCP_TOKEN_${s} missing, shorter than ${MIN_MCP_TOKEN_LENGTH} or shared with another agent: `
          + 'its Hermes cannot call HQ tools (only its final answer is saved)');
      }
      if (!cfg.model) warnings.push(`[worker] Hermes ${id}: HERMES_MODEL / HERMES_MODEL_${s} not set: its usage is recorded unpriced ($0)`);
    } else if (!!env[`HERMES_URL_${s}`]?.trim() !== !!env[`HERMES_KEY_${s}`]?.trim()) {
      warnings.push(`[worker] Hermes ${id}: set both HERMES_URL_${s} and HERMES_KEY_${s} (one is empty): it runs without Hermes`);
    }
  }
  const off = hermesRoles.filter((id) => !on.includes(id));
  const parts = [
    on.length ? `on Hermes: ${on.join(', ')}` : '',
    off.length ? `${fallback ? 'on the built-in runner (Hermes not configured)' : 'NOT RUNNABLE (Hermes not configured, HERMES_FALLBACK=off)'}: ${off.join(', ')}` : '',
  ].filter(Boolean);
  return { line: `[worker] runtime:hermes agents ${parts.join(' · ') || 'none'} · HERMES_FALLBACK ${fallback ? 'on' : 'off'}`, warnings };
}
