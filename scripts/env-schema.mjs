// Shared env schema for scripts/check-env.mjs and scripts/split-env.mjs: every variable the apps read, which
// service reads it, and which per-service env file it belongs to in production (docker-compose.yml env_file).
// Zero dependencies.

export const SERVICES = ['dashboard', 'worker', 'bot', 'brain', 'ops'];
/** Production env files (docker-compose.yml). ops variables stay only in the master .env (deploy/backup.sh). */
export const SERVICE_FILES = { dashboard: '.env.dashboard', bot: '.env.bot', worker: '.env.worker', brain: '.env.brain' };
/** Never allowed in a file, whatever the value (even empty): these would put a server secret in that container. */
export const FORBIDDEN_IN = {
  dashboard: ['SUPABASE_SERVICE_ROLE_KEY', 'VAULT_MASTER_KEY', 'VAULT_PREVIOUS_KEYS', 'SUPABASE_DB_URL', 'TELEGRAM_BOT_TOKEN',
              'BRAIN_WEBHOOK_SECRET', 'BRAIN_OPENAI_API_KEY'],
  bot: ['VAULT_MASTER_KEY', 'VAULT_PREVIOUS_KEYS', 'SUPABASE_DB_URL', 'HQ_INTERNAL_SECRET', 'BRAIN_INTERNAL_SECRET', 'BRAIN_WEBHOOK_SECRET', 'BRAIN_OPENAI_API_KEY'],
  // The worker runs agent code: it never gets the brain's secrets (docs/16-BRAIN.md "Isolation").
  worker: ['TELEGRAM_BOT_TOKEN', 'SUPABASE_DB_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'BRAIN_INTERNAL_SECRET', 'BRAIN_WEBHOOK_SECRET', 'BRAIN_OPENAI_API_KEY'],
  brain: ['VAULT_MASTER_KEY', 'VAULT_PREVIOUS_KEYS', 'SUPABASE_DB_URL', 'TELEGRAM_BOT_TOKEN', 'HQ_INTERNAL_SECRET', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
};

// ---------- .env parser (same rules as docker compose: KEY=VALUE, quotes, " #" comments on unquoted values) ----------
export function parseEnv(text) {
  const out = new Map();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) { out.set(`__bad_line_${i + 1}`, raw); continue; }
    let v = m[2];
    if (/^"/.test(v)) v = v.replace(/^"((?:[^"\\]|\\.)*)".*$/, '$1').replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
    else if (/^'/.test(v)) v = v.replace(/^'([^']*)'.*$/, '$1');
    else v = v.replace(/\s+#.*$/, '').trim();
    out.set(m[1], v);
  }
  return out;
}

// ---------- validators ----------
export const isUrl = (v, protocols = ['http:', 'https:']) => { try { return protocols.includes(new URL(v).protocol); } catch { return false; } };
export const isLocal = (v) => { try { return /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(new URL(v).hostname); } catch { return false; } };
const intIn = (min, max = Infinity) => (v) => /^-?\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? null : `must be an integer${max < Infinity ? ` between ${min} and ${max}` : ` ≥ ${min}`}`;
const b64key32 = (v) => { const b = Buffer.from(v, 'base64'); return /^[A-Za-z0-9+/]+={0,2}$/.test(v) && b.length === 32 ? null : 'must be base64 of exactly 32 bytes (openssl rand -base64 32)'; };
const jwtRole = (v) => { try { return JSON.parse(Buffer.from(v.split('.')[1], 'base64url').toString('utf8')).role; } catch { return undefined; } };
const telegramIds = (v) => { const ids = v.split(',').map((s) => s.trim()).filter(Boolean); return ids.length && ids.every((s) => /^-?\d{3,15}$/.test(s)) ? null : 'must be numeric Telegram id(s), comma-separated (ask @userinfobot), not @usernames'; };

function supabaseKey(kind) {
  return (v) => {
    if (kind === 'service' && v.startsWith('sb_publishable_')) return 'this is a publishable (anon) key; the worker and bot need the service_role / sb_secret_ key';
    if (kind === 'anon' && v.startsWith('sb_secret_')) return 'this is a SECRET key: never give it to the dashboard (browser). Use the anon / sb_publishable_ key';
    if (/^sb_(publishable|secret)_/.test(v)) return null;
    const role = jwtRole(v);
    if (!role) return 'does not look like a Supabase key (JWT eyJ… or sb_publishable_/sb_secret_…)';
    if (kind === 'service' && role !== 'service_role') return `JWT role is "${role}", expected "service_role"`;
    if (kind === 'anon' && role !== 'anon') return `JWT role is "${role}": the dashboard must get the anon key${role === 'service_role' ? ' (NEVER the service_role key)' : ''}`;
    return null;
  };
}

/** Agents that can run on Hermes (agents/roster.yaml runtime: hermes) → env suffix; see apps/worker/src/hermes/config.ts. */
export const HERMES_AGENTS = { 'web-dev': 'WEB_DEV', designer: 'DESIGNER', writer: 'WRITER', sales: 'SALES' };
const HERMES_AGENT_SUFFIXES = Object.values(HERMES_AGENTS);
/** Agents that can be switched to `runtime: claude` (any of the six) → env suffix; see apps/worker/src/claude/config.ts. */
export const CLAUDE_AGENTS = { coo: 'COO', 'web-dev': 'WEB_DEV', designer: 'DESIGNER', writer: 'WRITER', sales: 'SALES', 'qa-lead': 'QA_LEAD' };

// ---------- schema: every variable the code reads ----------
// req: services where it is required ('*prod' suffix = only required with --production)
const S = (o) => o;
export const VARS = [
  // Supabase
  S({ key: 'SUPABASE_URL', group: 'Supabase', svc: ['worker', 'bot', 'brain'], req: ['worker', 'bot', 'brain'], check: (v) => (isUrl(v) ? null : 'must be a URL'), prod: (v) => (v.startsWith('https://') ? null : 'use the https://<ref>.supabase.co URL in production') }),
  S({ key: 'SUPABASE_SERVICE_ROLE_KEY', group: 'Supabase', svc: ['worker', 'bot', 'brain'], req: ['worker', 'bot', 'brain'], secret: true, check: supabaseKey('service') }),
  S({ key: 'NEXT_PUBLIC_SUPABASE_URL', group: 'Supabase', svc: ['dashboard'], req: ['dashboard*prod'], check: (v) => (isUrl(v) ? null : 'must be a URL'), prod: (v) => (v.startsWith('https://') ? null : 'use https in production'), note: 'empty = DEMO mode (mock data)' }),
  S({ key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', group: 'Supabase', svc: ['dashboard'], req: ['dashboard*prod'], check: supabaseKey('anon') }),
  // AI
  S({ key: 'MODEL_PROFILE', group: 'AI', svc: ['worker'], check: (v) => (['free', 'paid', 'hybrid', 'claude', 'openai', 'kimi'].includes(v) ? null : 'must be free | paid | hybrid | claude | openai | kimi') }),
  ...['LEAD', 'DEV', 'DESIGN', 'WRITER', 'SALES', 'QA', 'LIGHT'].map((r) => S({ key: `MODEL_ID_${r}`, group: 'AI', svc: ['worker'],
    check: (v) => (/^(google|groq|openrouter|anthropic|openai|moonshot):\S+$/.test(v) ? null : 'must be provider:model, e.g. anthropic:claude-sonnet-5 (providers: google, groq, openrouter, anthropic, openai, moonshot)') })),
  S({ key: 'DAILY_AI_BUDGET_USD', group: 'AI', svc: ['worker', 'dashboard'], check: (v) => (/^\d+(\.\d+)?$/.test(v) ? null : 'must be a number ≥ 0 (0 = no cap)') }),
  S({ key: 'MONTHLY_BUDGET_USD', group: 'AI', svc: ['worker', 'bot'], check: (v) => (/^\d+(\.\d+)?$/.test(v) ? null : 'must be a number ≥ 0') }),
  ...['GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MOONSHOT_API_KEY']
    .map((key) => S({ key, group: 'AI', svc: ['worker'], secret: true, check: (v) => (v.length >= 20 && !/\s/.test(v) ? null : 'looks too short / has spaces') })),
  // Worker
  S({ key: 'POLL_INTERVAL_MS', group: 'Worker', svc: ['worker'], check: intIn(250) }),
  S({ key: 'MAX_PARALLEL_TASKS', group: 'Worker', svc: ['worker'], check: intIn(1, 16) }),
  S({ key: 'MAX_STEPS_PER_TASK', group: 'Worker', svc: ['worker'], check: intIn(1, 200) }),
  S({ key: 'MAX_COST_PER_TASK_USD', group: 'Worker', svc: ['worker'], check: (v) => (/^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? null : 'must be a number > 0 (USD)') }),
  S({ key: 'REPORTS_CHECK_MS', group: 'Worker', svc: ['worker'], check: intIn(1000) }),
  S({ key: 'QA_THRESHOLD', group: 'Worker', svc: ['worker'], check: intIn(0, 100) }),
  S({ key: 'TZ', group: 'Worker', svc: ['worker', 'bot', 'brain'], check: (v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return null; } catch { return 'unknown IANA time zone (e.g. Asia/Manila)'; } } }),
  S({ key: 'WORKER_HTTP_PORT', group: 'Worker', svc: ['worker'], check: intIn(1, 65535) }),
  S({ key: 'HQ_INTERNAL_SECRET', group: 'Worker', svc: ['dashboard', 'worker'], req: ['worker*prod', 'dashboard*prod'], secret: true, check: (v) => (v.length >= 32 ? null : 'too short: use openssl rand -hex 32') }),
  S({ key: 'HQ_WORKER_URL', group: 'Worker', svc: ['dashboard'], check: (v) => (isUrl(v) ? null : 'must be a URL'), note: 'docker-compose.yml overrides it with http://hq-worker:4000' }),
  S({ key: 'PLAYWRIGHT_CHROMIUM_PATH', group: 'Worker', svc: ['worker'] }),
  ...['AGENT_UID', 'AGENT_GID'].map((key) => S({ key, group: 'Worker', svc: ['worker'], check: intIn(1, 2147483647), note: 'set by the worker image (1001): agent commands run as this uid' })),
  ...['AGENTS_DIR', 'BRAIN_DIR', 'WORKSPACES_DIR', 'MODELS_FILE']
    .map((key) => S({ key, group: 'Worker', svc: key === 'AGENTS_DIR' ? ['dashboard', 'worker'] : key === 'MODELS_FILE' ? ['worker', 'brain'] : ['worker'], emptyIsBad: true, note: 'set by the Docker images' })),
  // Research & QA tools (all optional: tools report "not connected" without them)
  ...['TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'PAGESPEED_API_KEY', 'SEMRUSH_API_KEY', 'FIGMA_TOKEN', 'MEDIA_PROVIDER_KEY', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN']
    .map((key) => S({ key, group: 'Research & QA', svc: ['worker'], secret: true, check: (v) => (/\s/.test(v) ? 'has spaces' : null) })),
  S({ key: 'GOOGLE_OAUTH_CLIENT_ID', group: 'Research & QA', svc: ['worker'] }),
  S({ key: 'MEDIA_PROVIDER', group: 'Research & QA', svc: ['worker'], check: (v) => (v === 'http' ? null : 'only "http" (generic media gateway) is supported') }),
  S({ key: 'MEDIA_PROVIDER_URL', group: 'Research & QA', svc: ['worker'], check: (v) => (isUrl(v) ? null : 'must be a URL') }),
  S({ key: 'QA_EVIDENCE_TIMEOUT_MS', group: 'Research & QA', svc: ['worker'], check: intIn(5000) }),
  S({ key: 'ALLOW_PRIVATE_URLS', group: 'Research & QA', svc: ['worker'], prod: () => 'set in production: agents may fetch these private hosts (SSRF guard relaxed). Make sure that is intended', prodWarnOnly: true }),
  S({ key: 'LIGHTHOUSE_CLI', group: 'Research & QA', svc: ['worker'] }),
  S({ key: 'FFMPEG_PATH', group: 'Research & QA', svc: ['worker'] }),
  S({ key: 'FFPROBE_PATH', group: 'Research & QA', svc: ['worker'] }),
  S({ key: 'PLAYWRIGHT_BROWSERS_PATH', group: 'Research & QA', svc: ['worker'], note: 'set by the Playwright image' }),
  // Dev tools (M9)
  S({ key: 'DEV_SANDBOX_PREFIX', group: 'Dev agents', svc: ['worker'], check: (v) => { try { const a = JSON.parse(v); return Array.isArray(a) && a.every((x) => typeof x === 'string') ? null : 'must be a JSON array of strings'; } catch { return 'must be a JSON array, e.g. ["bwrap","--unshare-net"]'; } } }),
  S({ key: 'DEV_EXTRA_ALLOWED_HOSTS', group: 'Dev agents', svc: ['worker'], check: (v) => (v.split(',').map((x) => x.trim()).filter(Boolean).every((h) => /^(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(h)) ? null : 'must be host names, comma-separated (e.g. api.example.com,*.example.net)') }),
  S({ key: 'SHOPIFY_API_VERSION', group: 'Dev agents', svc: ['worker'], check: (v) => (/^\d{4}-\d{2}$/.test(v) || v === 'unstable' ? null : 'must look like 2025-07') }),
  // Vault
  S({ key: 'VAULT_MASTER_KEY', group: 'Client Vault', svc: ['worker'], req: ['worker*prod'], secret: true, check: b64key32 }),
  S({ key: 'VAULT_KEY_VERSION', group: 'Client Vault', svc: ['worker'], check: intIn(1) }),
  S({ key: 'VAULT_PREVIOUS_KEYS', group: 'Client Vault', svc: ['worker'], secret: true, check: (v) => {
    for (const part of v.split(',').map((s) => s.trim()).filter(Boolean)) {
      const i = part.indexOf(':');
      if (i < 1 || !/^\d+$/.test(part.slice(0, i))) return 'must look like 1:<base64>,2:<base64>';
      const e = b64key32(part.slice(i + 1)); if (e) return `version ${part.slice(0, i)}: ${e}`;
    }
    return null;
  } }),
  // RizeHub
  S({ key: 'RIZEHUB_API_URL', group: 'RizeHub', svc: ['worker'], check: (v) => (v.toLowerCase() === 'mock' || isUrl(v) ? null : 'must be "mock" or a URL ending in /agent-api/v1'),
    prod: (v) => (!v || v.toLowerCase() === 'mock' ? 'still on the built-in MOCK RizeHub (fine until RizeHub exposes /agent-api/v1)' : /\/agent-api\/v1\/?$/.test(v) ? null : 'should end with /agent-api/v1'), prodWarnOnly: true }),
  ...['LEADS', 'ONBOARDING', 'REPORTS', 'READONLY'].map((g) => S({ key: `RIZEHUB_KEY_${g}`, group: 'RizeHub', svc: ['worker'], secret: true })),
  S({ key: 'RIZEHUB_WEBHOOK_SECRET', group: 'RizeHub', svc: ['worker'], secret: true, check: (v) => (v.length >= 32 ? null : 'too short: use openssl rand -hex 32') }),
  S({ key: 'RIZEHUB_JOB_WAIT_MS', group: 'RizeHub', svc: ['worker'], check: intIn(0) }),
  S({ key: 'RIZEHUB_EVENTS_EVERY_MS', group: 'RizeHub', svc: ['worker'], check: intIn(500) }),
  S({ key: 'RIZEHUB_JOB_POLL_MS', group: 'RizeHub', svc: ['worker'], check: intIn(1000) }),
  S({ key: 'JOB_FEEDS_EVERY_MS', group: 'RizeHub', svc: ['worker'], check: intIn(0) }),
  S({ key: 'JOB_FEEDS', group: 'RizeHub', svc: ['worker'], check: (v) => { const bad = v.split(',').map((s) => s.trim()).filter((u) => u && !isUrl(u)); return bad.length ? `not URLs: ${bad.join(', ')}` : null; } }),
  // Sales outreach mailbox (apps/worker/src/sales/config.ts). All optional: without them nothing is sent or polled.
  S({ key: 'OUTREACH_ENABLED', group: 'Outreach', svc: ['worker'], check: (v) => (/^(true|false|1|0|yes|no|on|off)$/i.test(v) ? null : 'must be true | false') }),
  ...['SMTP', 'IMAP'].flatMap((k) => [
    S({ key: `OUTREACH_${k}_HOST`, group: 'Outreach', svc: ['worker'], check: (v) => (/^[a-z0-9.-]+$/i.test(v) ? null : 'must be a host name') }),
    S({ key: `OUTREACH_${k}_PORT`, group: 'Outreach', svc: ['worker'], check: intIn(1, 65535) }),
    S({ key: `OUTREACH_${k}_USER`, group: 'Outreach', svc: ['worker'] }),
    S({ key: `OUTREACH_${k}_PASS`, group: 'Outreach', svc: ['worker'], secret: true }),
  ]),
  S({ key: 'OUTREACH_FROM_NAME', group: 'Outreach', svc: ['worker'], check: (v) => (/rizehub/i.test(v) ? null : 'must name RizeHub, e.g. "Julev Ajeto, RizeHub"') }),
  S({ key: 'OUTREACH_FROM_EMAIL', group: 'Outreach', svc: ['worker'], check: (v) => (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v) ? null : 'must be an email address on the outreach domain') }),
  S({ key: 'OUTREACH_PHYSICAL_ADDRESS', group: 'Outreach', svc: ['worker'], check: (v) => (v.length >= 10 ? null : 'must be a full postal address (CAN-SPAM)') }),
  S({ key: 'OUTREACH_MAIN_DOMAIN', group: 'Outreach', svc: ['worker'] }),
  S({ key: 'OUTREACH_DAILY_SEND_CAP', group: 'Outreach', svc: ['worker'], check: intIn(0, 50) }),
  S({ key: 'OUTREACH_ALLOW_HIGHER_CAP', group: 'Outreach', svc: ['worker'] }),
  S({ key: 'OUTREACH_WARMUP_START', group: 'Outreach', svc: ['worker'], check: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? null : 'must be a date YYYY-MM-DD') }),
  S({ key: 'OUTREACH_WARMUP_START_PER_DAY', group: 'Outreach', svc: ['worker'], check: intIn(1, 50) }),
  S({ key: 'OUTREACH_WARMUP_STEP_PER_WEEK', group: 'Outreach', svc: ['worker'], check: intIn(0, 50) }),
  S({ key: 'OUTREACH_BATCH_HOUR', group: 'Outreach', svc: ['worker'], check: intIn(0, 23) }),
  S({ key: 'OUTREACH_QUIET_HOURS', group: 'Outreach', svc: ['worker'], check: (v) => (/^\d{1,2}(:00)?-\d{1,2}(:00)?$/.test(v) ? null : 'must be Manila hours like 22-7') }),
  S({ key: 'OUTREACH_UNSUBSCRIBE_URL', group: 'Outreach', svc: ['worker'], check: (v) => (isUrl(v) ? null : 'must be a URL') }),
  S({ key: 'OUTREACH_UNSUBSCRIBE_SECRET', group: 'Outreach', svc: ['worker'], secret: true, check: (v) => (v.length >= 32 ? null : 'too short: use openssl rand -hex 32') }),
  S({ key: 'OUTREACH_SEND_EVERY_MS', group: 'Outreach', svc: ['worker'], check: intIn(1000) }),
  S({ key: 'OUTREACH_IMAP_EVERY_MS', group: 'Outreach', svc: ['worker'], check: intIn(10_000) }),
  // Hermes Agent runtime (deploy/hermes/README.md): per-agent API server + the token its Hermes uses for the worker's /mcp
  ...HERMES_AGENT_SUFFIXES.flatMap((s) => [
    S({ key: `HERMES_URL_${s}`, group: 'Hermes', svc: ['worker'], check: (v) => (isUrl(v) ? null : 'must be a URL, e.g. http://hermes-web-dev:8642') }),
    S({ key: `HERMES_KEY_${s}`, group: 'Hermes', svc: ['worker'], secret: true, check: (v) => (v.length >= 32 && !/\s/.test(v) ? null : 'too short: use openssl rand -hex 32') }),
    S({ key: `HQ_MCP_TOKEN_${s}`, group: 'Hermes', svc: ['worker'], secret: true, check: (v) => (v.length >= 32 && !/\s/.test(v) ? null : 'too short: use openssl rand -hex 32') }),
    S({ key: `HERMES_MODEL_${s}`, group: 'Hermes', svc: ['worker'], check: (v) => (/^[\w./:-]+$/.test(v) ? null : 'must be a model id like claude-sonnet-5') }),
  ]),
  S({ key: 'HERMES_MODEL', group: 'Hermes', svc: ['worker'], check: (v) => (/^[\w./:-]+$/.test(v) ? null : 'must be a model id like claude-sonnet-5') }),
  S({ key: 'HERMES_PROVIDER', group: 'Hermes', svc: ['worker'], check: (v) => (['openrouter', 'anthropic', 'openai'].includes(v) ? null : 'must be openrouter | anthropic | openai') }),
  // Only the .env.hermes-<agent> files get these (split-env.mjs), never a service file.
  S({ key: 'HERMES_AUX_MODEL', group: 'Hermes', svc: ['ops'], check: (v) => (/^[\w./:-]+$/.test(v) ? null : 'must be a model id like google/gemini-2.5-flash-lite'), note: "Hermes' side tasks (titles, summaries, memory…)" }),
  S({ key: 'HERMES_OPENROUTER_API_KEY', group: 'Hermes', svc: ['ops'], secret: true, check: (v) => (/^sk-or-/.test(v) ? null : 'must be an OpenRouter key (sk-or-…)'), note: 'own key with its own credit limit; else OPENROUTER_API_KEY' }),
  S({ key: 'HERMES_FALLBACK', group: 'Hermes', svc: ['worker'], check: (v) => (['on', 'off'].includes(v.toLowerCase()) ? null : 'must be on | off') }),
  S({ key: 'HERMES_TIMEOUT_MS', group: 'Hermes', svc: ['worker'], check: intIn(10_000) }),
  // Claude Agent SDK runtime (docs/05 "Claude runtime"): off by default; also needs ANTHROPIC_API_KEY + MONTHLY_BUDGET_USD > 0
  S({ key: 'CLAUDE_RUNTIME_ENABLED', group: 'Claude runtime', svc: ['worker'], check: (v) => (['true', 'false', '1', '0', 'on', 'off', 'yes', 'no'].includes(v.toLowerCase()) ? null : 'must be true | false') }),
  S({ key: 'CLAUDE_FILE_TOOLS', group: 'Claude runtime', svc: ['worker'], check: (v) => (['hq', 'native'].includes(v) ? null : 'must be hq | native') }),
  S({ key: 'CLAUDE_TIMEOUT_MS', group: 'Claude runtime', svc: ['worker'], check: intIn(10_000) }),
  S({ key: 'CLAUDE_HQ_MCP_URL', group: 'Claude runtime', svc: ['worker'], check: (v) => (isUrl(v) ? null : 'must be a URL, e.g. http://127.0.0.1:4000/mcp') }),
  ...['', ...Object.values(CLAUDE_AGENTS).map((s) => `_${s}`)].map((s) => S({ key: `CLAUDE_MODEL${s}`, group: 'Claude runtime', svc: ['worker'],
    check: (v) => (/^(anthropic:)?claude-[\w.-]+$/.test(v) ? null : 'must be an Anthropic model id like claude-sonnet-5') })),
  // HQ Brain (docs/16-BRAIN.md): container hq-brain; the dashboard only gets the URL + internal secret
  S({ key: 'BRAIN_URL', group: 'Brain', svc: ['dashboard'], check: (v) => (isUrl(v) ? null : 'must be a URL'), note: 'docker-compose.yml overrides it with http://hq-brain:4100' }),
  S({ key: 'BRAIN_INTERNAL_SECRET', group: 'Brain', svc: ['dashboard', 'brain'], secret: true, check: (v) => (v.length >= 32 ? null : 'too short: use openssl rand -hex 32') }),
  S({ key: 'BRAIN_WEBHOOK_SECRET', group: 'Brain', svc: ['brain'], secret: true, check: (v) => (v.length >= 32 ? null : 'too short: use openssl rand -hex 32'), note: 'the GitHub webhook secret of the vault repo' }),
  S({ key: 'BRAIN_REPO_URL', group: 'Brain', svc: ['brain'], check: (v) => (/^(git@[\w.-]+:[\w./-]+\.git|https:\/\/\S+|\/\S+)$/.test(v) ? null : 'must be git@github.com:<owner>/<repo>.git (deploy key) or an https URL') }),
  S({ key: 'BRAIN_REPO_BRANCH', group: 'Brain', svc: ['brain'], check: (v) => (/^[\w./-]+$/.test(v) ? null : 'must be a branch name') }),
  S({ key: 'BRAIN_VAULT_DIR', group: 'Brain', svc: ['brain'], emptyIsBad: true, note: 'set by the brain image (/data/vault)' }),
  S({ key: 'BRAIN_DEPLOY_KEY_PATH', group: 'Brain', svc: ['brain'], note: 'set by docker-compose.yml (mounted from secrets/brain_deploy_key)' }),
  S({ key: 'BRAIN_KNOWN_HOSTS_PATH', group: 'Brain', svc: ['brain'], note: 'set by docker-compose.yml (secrets/brain_known_hosts)' }),
  S({ key: 'BRAIN_HTTP_PORT', group: 'Brain', svc: ['brain'], check: intIn(1, 65535) }),
  S({ key: 'BRAIN_POLL_SECONDS', group: 'Brain', svc: ['brain'], check: intIn(30, 86_400) }),
  S({ key: 'BRAIN_OPENAI_API_KEY', group: 'Brain', svc: ['brain'], secret: true, check: (v) => (/^sk-/.test(v) && !/\s/.test(v) ? null : 'must be an OpenAI key (sk-…)'), note: 'embeddings only; empty = keyword-only search' }),
  S({ key: 'BRAIN_EMBED_MODEL', group: 'Brain', svc: ['brain'], check: (v) => (/^openai:[\w.-]+$/.test(v) ? null : 'must be openai:<model>'), note: 'default: config/models.yaml embeddings' }),
  // Telegram
  S({ key: 'TELEGRAM_BOT_TOKEN', group: 'Telegram', svc: ['bot'], req: ['bot'], secret: true, check: (v) => (/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(v) ? null : 'does not look like a BotFather token (123456:ABC…)') }),
  S({ key: 'TELEGRAM_ALLOWED_USER_IDS', group: 'Telegram', svc: ['bot'], req: ['bot'], check: telegramIds }),
  S({ key: 'TELEGRAM_NOTIFY_CHAT_ID', group: 'Telegram', svc: ['bot'], check: (v) => (/^-?\d{3,15}$/.test(v) ? null : 'must be a numeric chat id') }),
  S({ key: 'BOT_POLL_MS', group: 'Telegram', svc: ['bot'], check: intIn(1000) }),
  S({ key: 'DASHBOARD_URL', group: 'Telegram', svc: ['dashboard', 'bot', 'worker'], check: (v) => (isUrl(v) ? null : 'must be a URL'), prod: (v) => (v.replace(/\/+$/, '') === 'https://hq.rizehub.ph' ? null : v.startsWith('https://') ? 'expected https://hq.rizehub.ph' : 'must be https://hq.rizehub.ph in production (client access links use it)') }),
  // Ops
  S({ key: 'SUPABASE_DB_URL', group: 'Ops', svc: ['ops'], secret: true, check: (v) => (isUrl(v, ['postgresql:', 'postgres:']) ? null : 'must be a postgresql:// connection string'), note: 'needed by deploy/backup.sh' }),
  S({ key: 'BACKUP_DIR', group: 'Ops', svc: ['ops'] }),
  S({ key: 'BACKUP_KEEP_DAYS', group: 'Ops', svc: ['ops'], check: intIn(1) }),
  // Dev-only (documented, commented out in .env.example)
  ...['MOCK_RIZEHUB_PORT', 'MOCK_RIZEHUB_HOST', 'HQ_WEBHOOK_URL', 'RIZEHUB_CHECK_WORKSPACE', 'RIZEHUB_CHECK_ACCOUNT'].map((key) => S({ key, group: 'Dev tools', svc: [], devOnly: true })),
  // Dashboard office previews: inlined by Next at build time (default /office), so no runtime env file needs it.
  S({ key: 'NEXT_PUBLIC_OFFICE_ASSETS', group: 'Dev tools', svc: [], devOnly: true }),
];
export const BY_KEY = new Map(VARS.map((v) => [v.key, v]));


/** Is KEY (possibly unknown to the schema) meant for this service's env file? Unknown names go to the worker
 * only (per-client platform tokens like SHOPIFY_TOKEN_<SLUG>, GITHUB_TOKEN_DEFAULT, DEV_GIT_AUTHOR_NAME, …). */
export function belongsTo(key, svc) {
  const v = BY_KEY.get(key);
  if (!v) return svc === 'worker' && !/^(NEXT_PUBLIC_|TELEGRAM_|BACKUP_)/.test(key);
  return v.svc.includes(svc);
}
