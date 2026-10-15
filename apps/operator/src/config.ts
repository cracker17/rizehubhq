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
//   OPERATOR_JOBS=on|off             worker mode (tasks: run, QA, approved actions, client updates). Default on
//   OPERATOR_JOB_TICK_MS             how often a queued job is looked for (default 10000, min 2000)
//   OPERATOR_MAX_USD_PER_JOB_RUN     spend cap for one run of a job (default 2)
//   OPERATOR_LOGIN_CHECK_MS          "still logged in?" check of every site (default 21600000 = 6 h, min 600000; also once at start)
//   OPERATOR_WORKSPACES_DIR          parent of each job's sandbox folder for the terminal tool (default /tmp/operator-jobs).
//                                    The terminal exists only when agent commands are isolated (AGENT_UID / DEV_SANDBOX_PREFIX)
//   OPERATOR_WEBFLOW_TOKEN_<CLIENT>  fallback API tokens when none is linked in the Client Vault (jobs/apis.ts)
//   OPERATOR_AIRTABLE_TOKEN_<CLIENT>
//   OPERATOR_HOOK_PORT               internal webhook listener (WhatsApp; default 4200; only with OPERATOR_WHATSAPP_APP_SECRET)
//   OPERATOR_WHATSAPP_*              WhatsApp Business (whatsapp.ts)
//   OPERATOR_SLACK_SELECTORS / OPERATOR_TEAMS_SELECTORS / OPERATOR_GMAIL_SELECTORS   JSON overrides for the watchers
//                                    of those channels (browser/watchers.ts)
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
  jobs: boolean;
  jobTickMs: number;
  maxUsdPerJobRun: number;
  loginCheckMs: number;
  workspacesDir: string;
  hookPort: number;
  watchOverrides: Record<'gmail' | 'slack' | 'teams', Record<string, string>>;
}

const truthy = (v: string | undefined) => ['1', 'true', 'on', 'yes'].includes((v ?? '').trim().toLowerCase());
const falsy = (v: string | undefined) => ['0', 'false', 'off', 'no'].includes((v ?? '').trim().toLowerCase());

function jsonSelectors(raw: string | undefined, name: string): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string' && v.trim())) as Record<string, string>;
    }
  } catch { /* below */ }
  throw new Error(`${name} must be a JSON object of selector strings`);
}

function int(v: string | undefined, fallback: number, min: number): number {
  const n = Number(v);
  return v?.trim() && Number.isFinite(n) ? Math.max(min, Math.round(n)) : fallback;
}

export function loadOperatorConfig(env: Env): OperatorConfig {
  const role = (env.OPERATOR_MODEL_ROLE ?? '').trim() as ModelRole;
  const usd = Number(env.OPERATOR_MAX_USD_PER_MESSAGE);
  const jobUsd = Number(env.OPERATOR_MAX_USD_PER_JOB_RUN);
  const selectorOverrides = jsonSelectors(env.OPERATOR_GCHAT_SELECTORS, 'OPERATOR_GCHAT_SELECTORS');
  return {
    enabled: truthy(env.OPERATOR_ENABLED),
    pollMs: int(env.OPERATOR_POLL_MS, 120_000, 30_000),
    tickMs: int(env.OPERATOR_TICK_MS, 5_000, 1_000),
    sends: !falsy(env.OPERATOR_SENDS),
    modelRole: (MODEL_ROLES as readonly string[]).includes(role) ? role : 'specialist',
    maxUsdPerMessage: Number.isFinite(usd) && usd > 0 ? usd : 0.25,
    selectorOverrides,
    jobs: !falsy(env.OPERATOR_JOBS),
    jobTickMs: int(env.OPERATOR_JOB_TICK_MS, 10_000, 2_000),
    maxUsdPerJobRun: Number.isFinite(jobUsd) && jobUsd > 0 ? jobUsd : 2,
    loginCheckMs: int(env.OPERATOR_LOGIN_CHECK_MS, 6 * 3600_000, 600_000),
    workspacesDir: env.OPERATOR_WORKSPACES_DIR?.trim() || '/tmp/operator-jobs',
    hookPort: int(env.OPERATOR_HOOK_PORT, 4200, 1024),
    watchOverrides: {
      gmail: jsonSelectors(env.OPERATOR_GMAIL_SELECTORS, 'OPERATOR_GMAIL_SELECTORS'),
      slack: jsonSelectors(env.OPERATOR_SLACK_SELECTORS, 'OPERATOR_SLACK_SELECTORS'),
      teams: jsonSelectors(env.OPERATOR_TEAMS_SELECTORS, 'OPERATOR_TEAMS_SELECTORS'),
    },
  };
}

/** OPERATOR_CDP_<PROFILE> (profile "madam-muse" → OPERATOR_CDP_MADAM_MUSE), else OPERATOR_CDP_URL, else null. */
export function cdpEndpointFor(profile: string, env: Env): string | null {
  const key = `OPERATOR_CDP_${profile.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const v = (env[key] ?? env.OPERATOR_CDP_URL ?? '').trim();
  return v ? v.replace(/\/+$/, '') : null;
}
