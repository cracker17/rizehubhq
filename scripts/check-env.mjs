#!/usr/bin/env node
// Validates a RizeHub HQ .env per service (dashboard, worker, bot, ops) and prints a friendly report.
// Zero dependencies (runs on the VPS through `docker run node:22-alpine` too).
//
//   pnpm check:env                         check ./.env for local development
//   pnpm check:env -- --production         stricter rules for the VPS (https, no mock, no localhost)
//   pnpm check:env -- --file path/to/.env  check another file
//   pnpm check:env -- --service worker     only one service (dashboard | worker | bot | ops)
//   pnpm check:env -- --example            check .env.example: every variable the code reads is documented, no secrets filled in
//   pnpm check:env -- --split [--production]  check the per-service production files .env.dashboard / .env.bot / .env.worker
//                                          (made by scripts/split-env.mjs). A file named like one of them is always checked
//                                          for its service only, and FAILS if it holds another service's secrets
//                                          (e.g. SUPABASE_SERVICE_ROLE_KEY or VAULT_MASTER_KEY in .env.dashboard).
//
// Exit code 1 when there are errors (warnings never fail).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BY_KEY, FORBIDDEN_IN, SERVICE_FILES, SERVICES, VARS, belongsTo, isLocal, isUrl, parseEnv } from './env-schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- args ----------
const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const EXAMPLE = flag('--example');
const PROD = flag('--production') || flag('--prod');
const SPLIT = flag('--split');
const FILE = path.resolve(opt('--file') ?? path.join(ROOT, EXAMPLE ? '.env.example' : '.env'));
const ONLY = opt('--service');
if (ONLY && !SERVICES.includes(ONLY)) { console.error(`--service must be one of ${SERVICES.join(', ')}`); process.exit(2); }

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

/** Service of a per-service production file (.env.dashboard → dashboard), else null. */
const serviceOfFile = (f) => Object.entries(SERVICE_FILES).find(([, name]) => path.basename(f) === name)?.[0] ?? null;

function loadEnv(file) {
  if (!fs.existsSync(file)) {
    const svc = serviceOfFile(file);
    err(`${path.relative(process.cwd(), file) || file} not found. ${svc ? 'Create it: node scripts/split-env.mjs (from .env)' : 'Create it: cp .env.example .env'}`);
    return null;
  }
  const env = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [k, raw] of env) if (k.startsWith('__bad_line_')) err(`${path.basename(file)}: line ${k.slice(11)} is not KEY=VALUE: ${raw.trim().slice(0, 60)}`);
  return env;
}

/** Per-service checks of one parsed env; returns [mark, key, message] rows. */
function serviceRows(svc, env) {
  const val = (k) => (env.get(k) ?? '').trim();
  const has = (k) => val(k) !== '';
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
    if (!n.startsWith('-') && !val('TELEGRAM_ALLOWED_USER_IDS').split(',').map((x) => x.trim()).includes(n)) rows.push([WARN, 'TELEGRAM_NOTIFY_CHAT_ID', 'is a private chat that is not in TELEGRAM_ALLOWED_USER_IDS']);
  }
  if (svc === 'ops' && !has('SUPABASE_DB_URL')) rows.push([WARN, 'SUPABASE_DB_URL', 'not set: deploy/backup.sh cannot run']);
  return rows;
}

/** A per-service file may hold only that service's variables; other services' secrets are errors. */
function leakRows(svc, env) {
  const rows = [];
  for (const k of env.keys()) {
    if (k.startsWith('__')) continue;
    if ((FORBIDDEN_IN[svc] ?? []).includes(k)) { rows.push([ERR, k, `must NOT be in ${SERVICE_FILES[svc]}: it would give the ${svc} container a secret it does not need. Remove the line (run scripts/split-env.mjs)`]); continue; }
    if (belongsTo(k, svc)) continue;
    const v = BY_KEY.get(k);
    const secretLike = v?.secret || /(KEY|TOKEN|SECRET|PASSWORD)/.test(k);
    rows.push(secretLike ? [ERR, k, `is a secret of ${v ? v.svc.join('/') || 'dev tools' : 'another service'}; it does not belong in ${SERVICE_FILES[svc]}`]
      : [WARN, k, `is not read by the ${svc} (belongs to ${v ? v.svc.join('/') || 'dev tools' : 'nobody'})`]);
  }
  return rows;
}

function printSection(title, rows, svcForErrors) {
  console.log(`\n${c(1, title)}`);
  if (!rows.length) console.log(`  ${c(2, '(nothing set)')}`);
  for (const [mark, k, msg] of rows) {
    console.log(`  ${mark} ${k.padEnd(30)} ${mark === OK ? c(2, msg) : msg}`);
    if (mark === ERR) errors.push(`${svcForErrors}: ${k} ${msg}`); else if (mark === WARN) warnings.push(`${svcForErrors}: ${k} ${msg}`);
  }
}

const codeVars = scanCodeVars();
const fileSvc = !EXAMPLE && !SPLIT ? serviceOfFile(FILE) : null;
const mode = EXAMPLE ? 'example' : PROD ? 'production' : 'local';
console.log(c(1, `RizeHub HQ env check · ${SPLIT ? Object.values(SERVICE_FILES).join(' + ') : path.relative(process.cwd(), FILE) || FILE} · ${mode}${ONLY ? ` · ${ONLY}` : ''}`));
for (const [k, where] of codeVars) if (!BY_KEY.has(k)) warn(`${k} is read in ${where} but check-env.mjs doesn't know it: add it to scripts/env-schema.mjs and .env.example`);

if (EXAMPLE) {
  const env = loadEnv(FILE);
  if (env) {
    const has = (k) => (env.get(k) ?? '').trim() !== '';
    const text = fs.readFileSync(FILE, 'utf8');
    for (const v of VARS) {
      const documented = env.has(v.key) || new RegExp(`^#\\s*${v.key}=`, 'm').test(text);
      if (!documented) err(`${v.key} is not documented in .env.example`);
      if (v.secret && has(v.key)) err(`${v.key} has a value in .env.example: secrets must stay empty`);
    }
    for (const k of env.keys()) if (!k.startsWith('__') && !BY_KEY.has(k)) warn(`${k} is in .env.example but not read by any app (typo or stale?)`);
    for (const v of VARS) if (!v.secret && has(v.key) && v.check && !v.devOnly) { const e = v.check(env.get(v.key).trim()); if (e) err(`${v.key}: example value ${e}`); }
    console.log(`  ${OK} ${VARS.length} known variables, ${codeVars.size} read in code, ${[...env.keys()].filter((k) => !k.startsWith('__')).length} set in the example`);
  }
} else if (SPLIT || fileSvc) {
  // Production layout: one file per service, each checked for its own service + for leaked secrets.
  const targets = SPLIT
    ? Object.entries(SERVICE_FILES).filter(([svc]) => !ONLY || ONLY === svc).map(([svc, name]) => [svc, path.join(path.dirname(opt('--file') ? FILE : path.join(ROOT, '.env')), name)])
    : [[fileSvc, FILE]];
  for (const [svc, file] of targets) {
    const env = loadEnv(file);
    if (!env) continue;
    printSection(`${svc} · ${path.basename(file)}`, [...serviceRows(svc, env), ...leakRows(svc, env)], svc);
  }
} else {
  const env = loadEnv(FILE);
  if (env) {
    for (const svc of ONLY ? [ONLY] : SERVICES) printSection(svc, serviceRows(svc, env), svc);
    for (const k of env.keys()) if (!k.startsWith('__') && !BY_KEY.has(k)) warnings.push(`${k} is set but no app reads it (typo?)`);
  }
}

const isSvc = (x) => /^(dashboard|worker|bot|ops): /.test(x);
const general = [...errors.filter((e) => !isSvc(e)), ...warnings.filter((w) => !isSvc(w))];
if (general.length) {
  console.log(`\n${c(1, 'general')}`);
  for (const e of errors.filter((x) => !isSvc(x))) console.log(`  ${ERR} ${e}`);
  for (const w of warnings.filter((x) => !isSvc(x))) console.log(`  ${WARN} ${w}`);
}
console.log(`\n${errors.length ? ERR : OK} ${errors.length} error(s), ${warnings.length} warning(s)`);
if (errors.length && !EXAMPLE) console.log(`  Fix the ✗ lines, then run this again. Template + comments: .env.example${SPLIT || fileSvc ? '; per-service files: node scripts/split-env.mjs' : ''}`);
process.exit(errors.length ? 1 : 0);
