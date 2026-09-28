#!/usr/bin/env node
// Validates a RizeHub HQ .env per service (dashboard, worker, bot, ops) and prints a friendly report.
// Zero dependencies (runs on the VPS through `docker run node:22-alpine` too).
//
//   pnpm check:env                         check ./.env for local development
//   pnpm check:env -- --production         stricter rules for the VPS (https, no mock, no localhost)
//   pnpm check:env -- --file path/to/.env  check another file
//   pnpm check:env -- --service worker     only one service (dashboard | worker | bot | ops)
//   pnpm check:env -- --example            check .env.example: every variable the code reads is documented, no secrets filled in
//
// Exit code 1 when there are errors (warnings never fail).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- args ----------
const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const EXAMPLE = flag('--example');
const PROD = flag('--production') || flag('--prod');
const FILE = path.resolve(opt('--file') ?? path.join(ROOT, EXAMPLE ? '.env.example' : '.env'));
const ONLY = opt('--service');
const SERVICES = ['dashboard', 'worker', 'bot', 'ops'];
if (ONLY && !SERVICES.includes(ONLY)) { console.error(`--service must be one of ${SERVICES.join(', ')}`); process.exit(2); }

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
const isUrl = (v, protocols = ['http:', 'https:']) => { try { return protocols.includes(new URL(v).protocol); } catch { return false; } };
const isLocal = (v) => { try { return /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(new URL(v).hostname); } catch { return false; } };
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

// ---------- schema: every variable the code reads ----------
// req: services where it is required ('*prod' suffix = only required with --production)
const S = (o) => o;
const VARS = [
  // Supabase
  S({ key: 'SUPABASE_URL', group: 'Supabase', svc: ['worker', 'bot'], req: ['worker', 'bot'], check: (v) => (isUrl(v) ? null : 'must be a URL'), prod: (v) => (v.startsWith('https://') ? null : 'use the https://<ref>.supabase.co URL in production') }),
  S({ key: 'SUPABASE_SERVICE_ROLE_KEY', group: 'Supabase', svc: ['worker', 'bot'], req: ['worker', 'bot'], secret: true, check: supabaseKey('service') }),
  S({ key: 'NEXT_PUBLIC_SUPABASE_URL', group: 'Supabase', svc: ['dashboard'], req: ['dashboard*prod'], check: (v) => (isUrl(v) ? null : 'must be a URL'), prod: (v) => (v.startsWith('https://') ? null : 'use https in production'), note: 'empty = DEMO mode (mock data)' }),
  S({ key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', group: 'Supabase', svc: ['dashboard'], req: ['dashboard*prod'], check: supabaseKey('anon') }),
  // AI
  S({ key: 'MODEL_PROFILE', group: 'AI', svc: ['worker'], check: (v) => (['free', 'hybrid', 'claude', 'openai'].includes(v) ? null : 'must be free | hybrid | claude | openai') }),
  S({ key: 'MONTHLY_BUDGET_USD', group: 'AI', svc: ['worker', 'bot'], check: (v) => (/^\d+(\.\d+)?$/.test(v) ? null : 'must be a number ≥ 0') }),
  ...['GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']
    .map((key) => S({ key, group: 'AI', svc: ['worker'], secret: true, check: (v) => (v.length >= 20 && !/\s/.test(v) ? null : 'looks too short / has spaces') })),
  // Worker
  S({ key: 'POLL_INTERVAL_MS', group: 'Worker', svc: ['worker'], check: intIn(250) }),
  S({ key: 'MAX_PARALLEL_TASKS', group: 'Worker', svc: ['worker'], check: intIn(1, 16) }),
  S({ key: 'REPORTS_CHECK_MS', group: 'Worker', svc: ['worker'], check: intIn(1000) }),
  S({ key: 'QA_THRESHOLD', group: 'Worker', svc: ['worker'], check: intIn(0, 100) }),
  S({ key: 'TZ', group: 'Worker', svc: ['worker', 'bot'], check: (v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return null; } catch { return 'unknown IANA time zone (e.g. Asia/Manila)'; } } }),
  S({ key: 'WORKER_HTTP_PORT', group: 'Worker', svc: ['worker'], check: intIn(1, 65535) }),
  S({ key: 'HQ_INTERNAL_SECRET', group: 'Worker', svc: ['dashboard', 'worker'], req: ['worker*prod', 'dashboard*prod'], secret: true, check: (v) => (v.length >= 32 ? null : 'too short: use openssl rand -hex 32') }),
  S({ key: 'HQ_WORKER_URL', group: 'Worker', svc: ['dashboard'], check: (v) => (isUrl(v) ? null : 'must be a URL'), note: 'docker-compose.yml overrides it with http://hq-worker:4000' }),
  S({ key: 'PLAYWRIGHT_CHROMIUM_PATH', group: 'Worker', svc: ['worker'] }),
  ...['AGENTS_DIR', 'BRAIN_DIR', 'WORKSPACES_DIR', 'MODELS_FILE']
    .map((key) => S({ key, group: 'Worker', svc: key === 'AGENTS_DIR' ? ['dashboard', 'worker'] : ['worker'], emptyIsBad: true, note: 'set by the Docker images' })),
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
  // Telegram
  S({ key: 'TELEGRAM_BOT_TOKEN', group: 'Telegram', svc: ['bot'], req: ['bot'], secret: true, check: (v) => (/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(v) ? null : 'does not look like a BotFather token (123456:ABC…)') }),
  S({ key: 'TELEGRAM_ALLOWED_USER_IDS', group: 'Telegram', svc: ['bot'], req: ['bot'], check: telegramIds }),
  S({ key: 'TELEGRAM_NOTIFY_CHAT_ID', group: 'Telegram', svc: ['bot'], check: (v) => (/^-?\d{3,15}$/.test(v) ? null : 'must be a numeric chat id') }),
  S({ key: 'BOT_POLL_MS', group: 'Telegram', svc: ['bot'], check: intIn(1000) }),
  S({ key: 'DASHBOARD_URL', group: 'Telegram', svc: ['dashboard', 'bot'], check: (v) => (isUrl(v) ? null : 'must be a URL'), prod: (v) => (v.replace(/\/+$/, '') === 'https://hq.rizehub.ph' ? null : v.startsWith('https://') ? 'expected https://hq.rizehub.ph' : 'must be https://hq.rizehub.ph in production (client access links use it)') }),
  // Ops
  S({ key: 'SUPABASE_DB_URL', group: 'Ops', svc: ['ops'], secret: true, check: (v) => (isUrl(v, ['postgresql:', 'postgres:']) ? null : 'must be a postgresql:// connection string'), note: 'needed by deploy/backup.sh' }),
  S({ key: 'BACKUP_DIR', group: 'Ops', svc: ['ops'] }),
  S({ key: 'BACKUP_KEEP_DAYS', group: 'Ops', svc: ['ops'], check: intIn(1) }),
  // Dev-only (documented, commented out in .env.example)
  ...['MOCK_RIZEHUB_PORT', 'MOCK_RIZEHUB_HOST', 'HQ_WEBHOOK_URL', 'RIZEHUB_CHECK_WORKSPACE', 'RIZEHUB_CHECK_ACCOUNT'].map((key) => S({ key, group: 'Dev tools', svc: [], devOnly: true })),
];
const BY_KEY = new Map(VARS.map((v) => [v.key, v]));

// ---------- code scan: every env var actually read in apps/*/src and packages ----------
function scanCodeVars() {
  const found = new Map();
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?[jt]sx?)$/.test(e.name) && !/\.test\./.test(e.name)) {
        const text = fs.readFileSync(p, 'utf8');
        const rel = path.relative(ROOT, p);
        const add = (k) => { if (!found.has(k)) found.set(k, rel); };
        // reads only: `env.X = …` (building a child-process env) is an assignment, not configuration
        for (const m of text.matchAll(/\b(?:process\.env|env|opts\.env)(?:\?)?\.([A-Z][A-Z0-9_]{2,})(?![A-Z0-9_])(?!\s*=[^=])/g)) add(m[1]);
        for (const m of text.matchAll(/(?:process\.env|\benv)\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g)) add(m[1]);
        for (const m of text.matchAll(/\b(?:readEnv|env|num)\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g)) add(m[1]);
        // template keys like `RIZEHUB_KEY_${g}` and provider maps ('GROQ_API_KEY')
        if (/env\[`RIZEHUB_KEY_\$\{/.test(text)) for (const g of ['LEADS', 'ONBOARDING', 'REPORTS', 'READONLY']) add(`RIZEHUB_KEY_${g}`);
        for (const m of text.matchAll(/:\s*'([A-Z][A-Z0-9]*_API_KEY)'/g)) add(m[1]);
        for (const m of text.matchAll(/envKey:\s*'([A-Z][A-Z0-9_]{2,})'/g)) add(m[1]);
      }
    }
  };
  for (const d of ['apps/dashboard/src', 'apps/worker/src', 'apps/bot/src', 'packages']) walk(path.join(ROOT, d));
  for (const k of ['NODE_ENV', 'PORT', 'HOSTNAME', 'NEXT_RUNTIME', 'CI']) found.delete(k);
  return found;
}

// ---------- AI provider coverage for the active profile ----------
function providersNeeded(profile) {
  try {
    const yaml = fs.readFileSync(path.join(ROOT, 'config', 'models.yaml'), 'utf8');
    const active = profile || /^active_profile:\s*([a-z]+)/m.exec(yaml)?.[1];
    const lines = yaml.split('\n');
    const start = lines.findIndex((l) => new RegExp(`^\\s{2}${active}:\\s*(#.*)?$`).test(l));
    if (start < 0) return { active, roles: null };
    const roles = {};
    for (const l of lines.slice(start + 1)) {
      if (/^\s{0,2}\S/.test(l)) break;
      const m = /^\s{4}([a-z]+):\s*\[(.*)\]/.exec(l);
      if (m) roles[m[1]] = [...new Set(m[2].split(',').map((s) => s.trim().split(':')[0]).filter(Boolean))];
    }
    return { active, roles };
  } catch { return { active: profile, roles: null }; }
}
const KEY_ENV = { google: 'GOOGLE_GENERATIVE_AI_API_KEY', groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

// ---------- report ----------
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const OK = c(32, '✓'), WARN = c(33, '!'), ERR = c(31, '✗');
const errors = [], warnings = [];
const err = (m) => errors.push(m), warn = (m) => warnings.push(m);

if (!fs.existsSync(FILE)) {
  console.error(`${ERR} ${path.relative(process.cwd(), FILE) || FILE} not found. Create it: cp .env.example .env`);
  process.exit(1);
}
const env = parseEnv(fs.readFileSync(FILE, 'utf8'));
for (const [k, raw] of env) if (k.startsWith('__bad_line_')) err(`line ${k.slice(11)} is not KEY=VALUE: ${raw.trim().slice(0, 60)}`);
const val = (k) => (env.get(k) ?? '').trim();
const has = (k) => val(k) !== '';

console.log(c(1, `RizeHub HQ env check · ${path.relative(process.cwd(), FILE) || FILE} · ${EXAMPLE ? 'example' : PROD ? 'production' : 'local'}${ONLY ? ` · ${ONLY}` : ''}`));

const codeVars = scanCodeVars();
for (const [k, where] of codeVars) if (!BY_KEY.has(k)) warn(`${k} is read in ${where} but check-env.mjs doesn't know it: add it to scripts/check-env.mjs and .env.example`);

if (EXAMPLE) {
  const text = fs.readFileSync(FILE, 'utf8');
  for (const v of VARS) {
    const documented = env.has(v.key) || new RegExp(`^#\\s*${v.key}=`, 'm').test(text);
    if (!documented) err(`${v.key} is not documented in .env.example`);
    if (v.secret && has(v.key)) err(`${v.key} has a value in .env.example: secrets must stay empty`);
  }
  for (const k of env.keys()) if (!k.startsWith('__') && !BY_KEY.has(k)) warn(`${k} is in .env.example but not read by any app (typo or stale?)`);
  for (const v of VARS) if (!v.secret && has(v.key) && v.check && !v.devOnly) { const e = v.check(val(v.key)); if (e) err(`${v.key}: example value ${e}`); }
  console.log(`  ${OK} ${VARS.length} known variables, ${codeVars.size} read in code, ${[...env.keys()].filter((k) => !k.startsWith('__')).length} set in the example`);
} else {
  const svcs = ONLY ? [ONLY] : SERVICES;
  for (const svc of svcs) {
    const rows = [];
    for (const v of VARS.filter((x) => x.svc.includes(svc))) {
      const required = (v.req ?? []).some((r) => r === svc || (PROD && r === `${svc}*prod`));
      if (!env.has(v.key) || !has(v.key)) {
        if (v.emptyIsBad && env.has(v.key)) rows.push([WARN, v.key, 'is set but EMPTY: remove the line (empty ≠ unset for the worker)']);
        else if (required) rows.push([ERR, v.key, `missing (required for ${svc})`]);
        continue;
      }
      const shown = v.secret ? `${val(v.key).slice(0, 4)}…(${val(v.key).length} chars)` : val(v.key).slice(0, 60);
      const e = v.check?.(val(v.key));
      if (e) { rows.push([ERR, v.key, e]); continue; }
      const p = PROD ? v.prod?.(val(v.key)) : null;
      if (p) { rows.push([v.prodWarnOnly ? WARN : ERR, v.key, p]); continue; }
      if (PROD && !v.prod && isUrl(val(v.key)) && isLocal(val(v.key)) && v.key !== 'HQ_WORKER_URL') { rows.push([ERR, v.key, 'points at localhost in production']); continue; }
      rows.push([OK, v.key, shown]);
    }
    // Service-level rules
    if (svc === 'worker') {
      const { active, roles } = providersNeeded(val('MODEL_PROFILE'));
      if (roles) {
        const missing = Object.entries(roles).filter(([, ps]) => !ps.some((p) => has(KEY_ENV[p]))).map(([r, ps]) => `${r} (${ps.map((p) => KEY_ENV[p]).join(' or ')})`);
        if (missing.length) rows.push([PROD ? ERR : WARN, 'AI keys', `profile "${active}" has no usable key for: ${missing.join('; ')}`]);
        else rows.push([OK, 'AI keys', `every role in profile "${active}" has at least one provider key`]);
        const paid = Object.values(roles).flat().some((p) => p === 'anthropic' || p === 'openai');
        if (paid && Number(val('MONTHLY_BUDGET_USD') || 0) === 0) rows.push([WARN, 'MONTHLY_BUDGET_USD', `profile "${active}" uses paid models but the budget is 0, so they will be skipped`]);
      } else rows.push([WARN, 'MODEL_PROFILE', `profile "${active}" not found in config/models.yaml`]);
      if (!has('VAULT_MASTER_KEY') && !PROD) rows.push([WARN, 'VAULT_MASTER_KEY', 'not set: Client Vault tools are disabled']);
      if (!has('HQ_INTERNAL_SECRET') && !PROD) rows.push([WARN, 'HQ_INTERNAL_SECRET', 'not set: worker /health and /chat answer 503 (Docker healthcheck will fail)']);
      const api = val('RIZEHUB_API_URL');
      if (api && api.toLowerCase() !== 'mock') {
        const miss = ['LEADS', 'ONBOARDING', 'REPORTS', 'READONLY'].filter((g) => !has(`RIZEHUB_KEY_${g}`));
        if (miss.length) rows.push([WARN, 'RIZEHUB_KEY_*', `real RizeHub configured but no key for: ${miss.join(', ')} (those tools will fail)`]);
        if (!has('RIZEHUB_WEBHOOK_SECRET')) rows.push([PROD ? ERR : WARN, 'RIZEHUB_WEBHOOK_SECRET', 'required with a real RizeHub (webhooks answer 503 without it)']);
      }
    }
    if (svc === 'dashboard') {
      if (has('NEXT_PUBLIC_SUPABASE_URL') !== has('NEXT_PUBLIC_SUPABASE_ANON_KEY')) rows.push([ERR, 'NEXT_PUBLIC_SUPABASE_*', 'set both URL and anon key (or neither for DEMO mode)']);
      if (!has('NEXT_PUBLIC_SUPABASE_URL') && !PROD) rows.push([WARN, 'mode', 'DEMO (no Supabase): mock data, no login']);
      if (has('SUPABASE_URL') && has('NEXT_PUBLIC_SUPABASE_URL') && val('SUPABASE_URL').replace(/\/+$/, '') !== val('NEXT_PUBLIC_SUPABASE_URL').replace(/\/+$/, ''))
        rows.push([WARN, 'NEXT_PUBLIC_SUPABASE_URL', `differs from SUPABASE_URL (${val('SUPABASE_URL')}): dashboard and worker would use different projects`]);
      if (has('NEXT_PUBLIC_SUPABASE_ANON_KEY') && val('NEXT_PUBLIC_SUPABASE_ANON_KEY') === val('SUPABASE_SERVICE_ROLE_KEY')) rows.push([ERR, 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'equals the service_role key: NEVER expose it to the browser']);
    }
    if (svc === 'bot' && has('TELEGRAM_NOTIFY_CHAT_ID') && has('TELEGRAM_ALLOWED_USER_IDS')) {
      const n = val('TELEGRAM_NOTIFY_CHAT_ID');
      if (!n.startsWith('-') && !val('TELEGRAM_ALLOWED_USER_IDS').split(',').map((s) => s.trim()).includes(n)) rows.push([WARN, 'TELEGRAM_NOTIFY_CHAT_ID', 'is a private chat that is not in TELEGRAM_ALLOWED_USER_IDS']);
    }
    if (svc === 'ops' && !has('SUPABASE_DB_URL')) rows.push([WARN, 'SUPABASE_DB_URL', 'not set: deploy/backup.sh cannot run']);

    console.log(`\n${c(1, svc)}`);
    if (!rows.length) console.log(`  ${c(2, '(nothing set)')}`);
    for (const [mark, k, msg] of rows) {
      console.log(`  ${mark} ${k.padEnd(30)} ${mark === OK ? c(2, msg) : msg}`);
      if (mark === ERR) errors.push(`${svc}: ${k} ${msg}`); else if (mark === WARN) warnings.push(`${svc}: ${k} ${msg}`);
    }
  }
  for (const k of env.keys()) if (!k.startsWith('__') && !BY_KEY.has(k)) warnings.push(`${k} is set but no app reads it (typo?)`);
}

const general = [...errors.filter((e) => !/^(dashboard|worker|bot|ops): /.test(e)), ...warnings.filter((w) => !/^(dashboard|worker|bot|ops): /.test(w))];
if (general.length) {
  console.log(`\n${c(1, 'general')}`);
  for (const e of errors.filter((x) => !/^(dashboard|worker|bot|ops): /.test(x))) console.log(`  ${ERR} ${e}`);
  for (const w of warnings.filter((x) => !/^(dashboard|worker|bot|ops): /.test(x))) console.log(`  ${WARN} ${w}`);
}
console.log(`\n${errors.length ? ERR : OK} ${errors.length} error(s), ${warnings.length} warning(s)`);
if (errors.length && !EXAMPLE) console.log('  Fix the ✗ lines in your .env, then run this again. Template + comments: .env.example');
process.exit(errors.length ? 1 : 0);
