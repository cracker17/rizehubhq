// Operator configuration (docs/17-OPERATOR.md "Environment"). Read from workerEnv(): the frozen startup snapshot with the
// dashboard's provider keys laid over it (Admin → API & AI), so ANTHROPIC_API_KEY and the budgets come from the same
// place the worker uses. Nothing here is a secret except the API key, which is read per call and never logged.
//
//   OPERATOR_ENABLED=true            master switch (default off: the container idles)
//   OPERATOR_POLL_MS                 how often each watched chat is read (default 120000 = 2 min, min 30000)
//   OPERATOR_TICK_MS                 classify / send loop interval (default 5000)
//   OPERATOR_SENDS=on|off            off = never post (drafts and approvals still work). Default on; the kill switch
//                                    (/pause, operator_paused) is checked in SQL either way
//   OPERATOR_CDP_<PROFILE>           CDP endpoint of a client's browser profile (e.g. OPERATOR_CDP_LVLUP=http://ws-lvlup:9223)
//   OPERATOR_CDP_URL                 fallback endpoint for profiles without their own
//   OPERATOR_MODEL_ROLE              model role for classify + draft (default specialist; CLAUDE_MODEL_OPERATOR overrides)
//   OPERATOR_MAX_USD_PER_MESSAGE     spend cap for one classify + draft call (default 0.25)
//   OPERATOR_GCHAT_SELECTORS         JSON overrides for the Google Chat DOM selectors (browser/selectors.ts)
import { MODEL_ROLES, type ModelRole } from '@rizehubhq/shared';

type Env = Readonly<Record<string, string | undefined>>;

export interface OperatorConfig {
  enabled: boolean;
  pollMs: number;
  tickMs: number;
  sends: boolean;
  modelRole: ModelRole;
  maxUsdPerMessage: number;
  selectorOverrides: Record<string, string>;
}

const truthy = (v: string | undefined) => ['1', 'true', 'on', 'yes'].includes((v ?? '').trim().toLowerCase());
const falsy = (v: string | undefined) => ['0', 'false', 'off', 'no'].includes((v ?? '').trim().toLowerCase());

function int(v: string | undefined, fallback: number, min: number): number {
  const n = Number(v);
  return v?.trim() && Number.isFinite(n) ? Math.max(min, Math.round(n)) : fallback;
}

export function loadOperatorConfig(env: Env): OperatorConfig {
  const role = (env.OPERATOR_MODEL_ROLE ?? '').trim() as ModelRole;
  const usd = Number(env.OPERATOR_MAX_USD_PER_MESSAGE);
  let selectorOverrides: Record<string, string> = {};
  if (env.OPERATOR_GCHAT_SELECTORS?.trim()) {
    try {
      const parsed = JSON.parse(env.OPERATOR_GCHAT_SELECTORS) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        selectorOverrides = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string' && v.trim())) as Record<string, string>;
      }
    } catch { throw new Error('OPERATOR_GCHAT_SELECTORS must be a JSON object of selector strings'); }
  }
  return {
    enabled: truthy(env.OPERATOR_ENABLED),
    pollMs: int(env.OPERATOR_POLL_MS, 120_000, 30_000),
    tickMs: int(env.OPERATOR_TICK_MS, 5_000, 1_000),
    sends: !falsy(env.OPERATOR_SENDS),
    modelRole: (MODEL_ROLES as readonly string[]).includes(role) ? role : 'specialist',
    maxUsdPerMessage: Number.isFinite(usd) && usd > 0 ? usd : 0.25,
    selectorOverrides,
  };
}

/** OPERATOR_CDP_<PROFILE> (profile "madam-muse" → OPERATOR_CDP_MADAM_MUSE), else OPERATOR_CDP_URL, else null. */
export function cdpEndpointFor(profile: string, env: Env): string | null {
  const key = `OPERATOR_CDP_${profile.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const v = (env[key] ?? env.OPERATOR_CDP_URL ?? '').trim();
  return v ? v.replace(/\/+$/, '') : null;
}
