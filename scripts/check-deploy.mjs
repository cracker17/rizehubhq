#!/usr/bin/env node
// pnpm check:deploy: M11 go-live readiness, everything that can be checked WITHOUT a VPS, keys or DNS
// (docs/10-DEPLOY-VPS.md "Go-live runbook" step 0). Run it before every deploy; CI runs it too.
//
//   pnpm check:deploy                  all checks
//   pnpm check:deploy -- --skip-db     skip the migrations run (scripts/db-test.mjs in PGlite, ~10 s)
//   pnpm check:deploy -- --skip-docker skip `docker compose config` (also skipped automatically when docker is absent)
//
// Checks: env schema + .env.example (check-env --example) and compose/Dockerfile env ↔ scripts/env-schema.mjs;
// docker compose config parses (default + hermes profile); proxy domains (Caddyfile, nginx, setup-vps.sh, compose ports,
// DASHBOARD_URL rule) all agree on hq.rizehub.ph → 127.0.0.1:3100; deploy/**/*.sh pass `bash -n` (+ shellcheck when
// installed) and are executable; migrations apply cleanly in PGlite; Dockerfiles only COPY paths that exist and are not
// .dockerignored, their CMD entry files exist, and the Playwright image matches playwright-core.
// Exit 1 when any check fails; skipped checks never fail.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BY_KEY, SERVICE_FILES, belongsTo } from './env-schema.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOMAIN = 'hq.rizehub.ph';
export const DASHBOARD_UPSTREAM = '127.0.0.1:3100';
const APP_SERVICES = ['dashboard', 'worker', 'bot'];
/** Set by Docker/Node/Next/tooling, not app configuration: never expected in env-schema.mjs. */
const PLATFORM_VARS = new Set(['NODE_ENV', 'PORT', 'HOSTNAME', 'PATH', 'HOME', 'CI', 'PNPM_HOME', 'COREPACK_HOME', 'NEXT_TELEMETRY_DISABLED', 'TZ', 'DEBIAN_FRONTEND']);

// ---------- small pure helpers (unit-tested in scripts/deploy.test.mjs) ----------

/** Dockerfile → logical instructions ({ op, args, line }) with `\` continuations joined and comments dropped. */
export function parseDockerfile(text) {
  const out = [];
  let buf = '';
  let start = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (!buf && (/^\s*#/.test(line) || !line.trim())) return;
    if (buf && /^\s*#/.test(line)) return; // comment inside a continuation
    if (!buf) start = i + 1;
    buf += (buf ? ' ' : '') + line.replace(/\\$/, '').trim();
    if (line.endsWith('\\')) return;
    const m = /^(\w+)\s+([\s\S]*)$/.exec(buf);
    if (m) out.push({ op: m[1].toUpperCase(), args: m[2].trim(), line: start });
    buf = '';
  });
  return out;
}

/** COPY/ADD sources that come from the build context (not --from=<stage>). JSON-array form supported. */
export function contextCopies(instrs) {
  const out = [];
  for (const { op, args, line } of instrs) {
    if (op !== 'COPY' && op !== 'ADD') continue;
    let parts;
    const rest = args.replace(/^(--[\w-]+(=\S+)?\s+)+/, (flags) => { if (/--from=/.test(flags)) parts = []; return ''; });
    if (parts) continue; // COPY --from=<stage>: not from the context
    if (rest.startsWith('[')) { try { parts = JSON.parse(rest); } catch { parts = []; } } else parts = rest.split(/\s+/);
    for (const src of parts.slice(0, -1)) out.push({ src: src.replace(/^\.\/+/, ''), line });
  }
  return out;
}

function globToRegex(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*' && p[i + 1] === '*') { re += p[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += p[i + 2] === '/' ? 2 : 1; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** .dockerignore semantics (simplified: last matching rule wins, `!` re-includes, a match on a parent dir excludes children). */
export function dockerignored(relPath, ignoreText) {
  const rules = ignoreText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => ({ neg: l.startsWith('!'), re: globToRegex(l.replace(/^!/, '').replace(/^\/+|\/+$/g, '')) }));
  const segs = relPath.replace(/^\.\/+|\/+$/g, '').split('/');
  let ignored = false;
  for (const r of rules) {
    for (let n = 1; n <= segs.length; n++) {
      if (r.re.test(segs.slice(0, n).join('/'))) { ignored = !r.neg; break; }
    }
  }
  return ignored;
}

/** Active (non-comment) Caddyfile site addresses and reverse_proxy upstreams. */
export function caddySites(text) {
  const sites = [];
  const upstreams = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '');
    const site = /^([^\s{][^{]*?)\s*\{\s*$/.exec(line);
    if (site) sites.push(...site[1].split(/[\s,]+/).filter(Boolean));
    const rp = /^\s*reverse_proxy\s+(\S+)/.exec(line);
    if (rp) upstreams.push(rp[1]);
  }
  return { sites, upstreams };
}

/** Active nginx server_name values and proxy_pass targets. */
export function nginxSites(text) {
  const active = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '')).join('\n');
  const names = [...active.matchAll(/\bserver_name\s+([^;]+);/g)].flatMap((m) => m[1].trim().split(/\s+/));
  const upstreams = [...active.matchAll(/\bproxy_pass\s+([^;]+);/g)].map((m) => m[1].trim());
  return { names, upstreams };
}

// ---------- check runner ----------

export function createReport() {
  const rows = [];
  const add = (group, status, msg) => rows.push({ group, status, msg });
  return {
    rows,
    ok: (g, m) => add(g, 'ok', m),
    fail: (g, m) => add(g, 'fail', m),
    skip: (g, m) => add(g, 'skip', m),
    check: (g, cond, okMsg, failMsg) => add(g, cond ? 'ok' : 'fail', cond ? okMsg : failMsg ?? okMsg),
  };
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
const has = (cmd) => run('sh', ['-c', `command -v ${cmd}`]).status === 0;
const lastLines = (s, n = 6) => String(s ?? '').trim().split('\n').slice(-n).join('\n    ');

function loadYaml() {
  try { return createRequire(path.join(ROOT, 'apps/worker/package.json'))('yaml'); } catch { return null; }
}

function loadCompose(r) {
  const YAML = loadYaml();
  if (!YAML) { r.fail('compose', 'cannot load the "yaml" package: run pnpm install'); return null; }
  try { return YAML.parse(read('docker-compose.yml'), { merge: true }); } catch (e) { r.fail('compose', `docker-compose.yml does not parse: ${e.message}`); return null; }
}

function envEntries(env) {
  if (!env) return [];
  return Array.isArray(env) ? env.map((e) => String(e).split('=')[0]) : Object.keys(env);
}
const envFiles = (svc) => [svc.env_file ?? []].flat().map((f) => (typeof f === 'string' ? f : f.path));

export function checkEnv(r, compose) {
  const G = 'env';
  const ex = run(process.execPath, ['scripts/check-env.mjs', '--example']);
  r.check(G, ex.status === 0, '.env.example documents every variable the code reads (check-env --example)',
    `check-env --example failed:\n    ${lastLines(ex.stdout || ex.stderr, 10)}`);
  const warn = /(\d+) warning\(s\)/.exec(ex.stdout ?? '');
  if (ex.status === 0 && warn && warn[1] !== '0') r.fail(G, `check-env --example: ${warn[1]} warning(s) (unknown variables): fix scripts/env-schema.mjs / .env.example`);
  if (!compose) return;
  for (const name of APP_SERVICES) {
    const svc = compose.services?.[name];
    if (!svc) { r.fail(G, `docker-compose.yml has no "${name}" service`); continue; }
    const files = envFiles(svc);
    r.check(G, files.length === 1 && files[0] === SERVICE_FILES[name], `${name}: env_file ${SERVICE_FILES[name]} (per-service split)`,
      `${name}: env_file is ${JSON.stringify(files)}, expected ["${SERVICE_FILES[name]}"] (scripts/env-schema.mjs SERVICE_FILES)`);
    const bad = envEntries(svc.environment).filter((k) => !PLATFORM_VARS.has(k) && (!BY_KEY.has(k) || !belongsTo(k, name)));
    r.check(G, !bad.length, `${name}: every compose environment variable is in env-schema.mjs for ${name}`,
      `${name}: compose sets ${bad.join(', ')} but scripts/env-schema.mjs does not list ${bad.length > 1 ? 'them' : 'it'} for ${name}`);
  }
  // Variables the app images set with ENV must be known to the schema too (e.g. AGENTS_DIR, MODELS_FILE).
  for (const name of APP_SERVICES) {
    const df = `apps/${name}/Dockerfile`;
    if (!exists(df)) continue;
    const keys = parseDockerfile(read(df)).filter((i) => i.op === 'ENV')
      .flatMap((i) => [...i.args.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=/g)].map((m) => m[1]));
    const unknown = [...new Set(keys)].filter((k) => !PLATFORM_VARS.has(k) && !BY_KEY.has(k));
    r.check(G, !unknown.length, `${df}: ENV variables are known to env-schema.mjs`, `${df}: ENV ${unknown.join(', ')} not in scripts/env-schema.mjs`);
  }
}

export function checkDocker(r, { skip }) {
  const G = 'compose';
  if (skip) return r.skip(G, 'docker compose config (--skip-docker)');
  if (!has('docker') || run('docker', ['compose', 'version']).status !== 0) return r.skip(G, 'docker compose config: docker / compose plugin not installed (CI and the VPS run it)');
  // Throwaway project dir with per-service files split from .env.example, so the real .env* files are never touched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rzh-deploy-'));
  try {
    fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(dir, '.env'));
    const split = run(process.execPath, ['scripts/split-env.mjs', '--in', path.join(dir, '.env')]);
    if (split.status !== 0) return r.fail(G, `split-env.mjs on .env.example failed:\n    ${lastLines(split.stderr || split.stdout)}`);
    for (const profile of [[], ['--profile', 'hermes']]) {
      const res = run('docker', ['compose', '-f', 'docker-compose.yml', '--project-directory', dir, ...profile, 'config', '--quiet']);
      const label = profile.length ? 'docker compose --profile hermes config' : 'docker compose config';
      r.check(G, res.status === 0, `${label} parses`, `${label} failed:\n    ${lastLines(res.stderr || res.stdout)}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export function checkComposeFiles(r, compose) {
  const G = 'compose';
  if (!compose) return;
  for (const [name, svc] of Object.entries(compose.services ?? {})) {
    for (const p of [svc.ports ?? []].flat()) {
      const s = String(typeof p === 'object' ? `${p.host_ip ?? ''}:${p.published}:${p.target}` : p);
      r.check(G, /^127\.0\.0\.1:/.test(s), `${name}: port ${s} is loopback-only`, `${name}: port "${s}" is published beyond 127.0.0.1 (only the reverse proxy may be public)`);
    }
    for (const v of svc.volumes ?? []) {
      const src = typeof v === 'string' ? v.split(':')[0] : v.source;
      if (!src || !/^\.{1,2}\//.test(src)) continue; // named volume
      r.check(G, exists(src), `${name}: bind mount ${src} exists`, `${name}: bind mount source ${src} does not exist`);
    }
  }
}

export function checkProxy(r, compose) {
  const G = 'proxy';
  const caddy = caddySites(read('deploy/Caddyfile'));
  r.check(G, caddy.sites.length === 1 && caddy.sites[0] === DOMAIN, `deploy/Caddyfile serves ${DOMAIN}`, `deploy/Caddyfile site(s) ${JSON.stringify(caddy.sites)}, expected ["${DOMAIN}"]`);
  r.check(G, caddy.upstreams.length > 0 && caddy.upstreams.every((u) => u === DASHBOARD_UPSTREAM), `deploy/Caddyfile → ${DASHBOARD_UPSTREAM}`,
    `deploy/Caddyfile reverse_proxy ${JSON.stringify(caddy.upstreams)}, expected ${DASHBOARD_UPSTREAM}`);
  const conf = `deploy/nginx/${DOMAIN}.conf`;
  if (!exists(conf)) r.fail(G, `${conf} is missing`);
  else {
    const ng = nginxSites(read(conf));
    r.check(G, ng.names.length > 0 && ng.names.every((n) => n === DOMAIN), `${conf}: server_name ${DOMAIN}`, `${conf}: server_name ${JSON.stringify(ng.names)}, expected ${DOMAIN}`);
    r.check(G, ng.upstreams.length > 0 && ng.upstreams.every((u) => u.replace(/^https?:\/\//, '').replace(/\/$/, '') === DASHBOARD_UPSTREAM),
      `${conf}: proxy_pass → ${DASHBOARD_UPSTREAM}`, `${conf}: proxy_pass ${JSON.stringify(ng.upstreams)}, expected http://${DASHBOARD_UPSTREAM}`);
  }
  const setup = read('deploy/setup-vps.sh');
  r.check(G, setup.includes(`DOMAIN="\${DOMAIN:-${DOMAIN}}"`) && setup.includes(`deploy/nginx/${DOMAIN}.conf`),
    `deploy/setup-vps.sh defaults to ${DOMAIN} and installs ${conf}`, `deploy/setup-vps.sh does not default DOMAIN to ${DOMAIN} / install ${conf}`);
  const dash = BY_KEY.get('DASHBOARD_URL');
  r.check(G, !!dash?.prod && dash.prod(`https://${DOMAIN}`) === null, `env-schema: DASHBOARD_URL=https://${DOMAIN} is valid in production`,
    `env-schema: DASHBOARD_URL production rule rejects https://${DOMAIN}`);
  if (compose) {
    const ports = [compose.services?.dashboard?.ports ?? []].flat().map(String);
    r.check(G, ports.includes(`${DASHBOARD_UPSTREAM}:3000`), `compose: dashboard published on ${DASHBOARD_UPSTREAM} (the proxy upstream)`,
      `compose: dashboard ports ${JSON.stringify(ports)} do not publish ${DASHBOARD_UPSTREAM}:3000`);
  }
  // Every rizehub.* host named in the deploy kit must be the HQ domain (or RizeHub's own apex in the Agent API snippets).
  const hosts = new Set();
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const p = path.join(rel, e.name);
      if (e.isDirectory()) walk(p);
      else for (const m of read(p).matchAll(/\b([a-z0-9-]+\.)*rizehub\.[a-z]{2,}\b/gi)) hosts.add(m[0].toLowerCase());
    }
  };
  walk('deploy');
  for (const m of read('docker-compose.yml').matchAll(/\b([a-z0-9-]+\.)*rizehub\.[a-z]{2,}\b/gi)) hosts.add(m[0].toLowerCase());
  const odd = [...hosts].filter((h) => h !== DOMAIN && h !== 'rizehub.ph');
  r.check(G, !odd.length, `deploy kit names no other rizehub host than ${DOMAIN}`, `deploy kit mentions unexpected host(s): ${odd.join(', ')}`);
}

export function checkShell(r) {
  const G = 'scripts';
  const files = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const p = path.join(rel, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.sh')) files.push(p);
    }
  };
  walk('deploy');
  files.sort();
  const shellcheck = has('shellcheck');
  for (const f of files) {
    const n = run('bash', ['-n', f]);
    r.check(G, n.status === 0, `${f}: bash -n`, `${f}: bash -n failed:\n    ${lastLines(n.stderr)}`);
    r.check(G, (fs.statSync(path.join(ROOT, f)).mode & 0o111) !== 0, `${f}: executable`, `${f}: not executable (chmod +x; docs/10 runs it as ./${f})`);
    if (shellcheck) {
      const sc = run('shellcheck', ['-S', 'style', f]);
      r.check(G, sc.status === 0, `${f}: shellcheck -S style`, `${f}: shellcheck:\n    ${lastLines(sc.stdout, 12)}`);
    }
  }
  if (!shellcheck) r.skip(G, 'shellcheck not installed (apt install shellcheck); CI runs it');
}

export function checkMigrations(r, { skip }) {
  const G = 'database';
  const files = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
  const bad = files.filter((f) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(f));
  const stamps = files.map((f) => f.slice(0, 14));
  r.check(G, !bad.length && new Set(stamps).size === stamps.length, `${files.length} migrations, unique <14-digit timestamp>_<name>.sql`,
    `migration names: ${bad.length ? `bad ${bad.join(', ')}` : 'duplicate timestamps'}`);
  if (skip) return r.skip(G, 'migrations + seed in PGlite (--skip-db)');
  const res = run(process.execPath, ['scripts/db-test.mjs'], { timeout: 300_000 });
  const passed = /All (\d+) database checks passed \(incl\. extra suites\)/.exec(res.stdout ?? '');
  if (res.status === 0 && passed) r.ok(G, `migrations + seed apply cleanly in PGlite; ${passed[1]} database checks pass (scripts/db-test.mjs)`);
  else if (/Cannot find (package|module) '@electric-sql\/pglite'/.test(res.stderr ?? '')) r.fail(G, 'PGlite not installed: run pnpm install');
  else r.fail(G, `scripts/db-test.mjs failed:\n    ${lastLines(res.stderr || res.stdout, 8)}`);
}

export function checkDockerfiles(r, compose) {
  const G = 'images';
  if (!compose) return;
  const builds = Object.entries(compose.services ?? {}).filter(([, s]) => s.build)
    .map(([name, s]) => ({ name, context: typeof s.build === 'string' ? s.build : s.build.context ?? '.', dockerfile: (typeof s.build === 'object' && s.build.dockerfile) || 'Dockerfile' }));
  const seen = new Set();
  for (const b of builds) {
    const df = path.normalize(path.join(b.context, b.dockerfile));
    if (seen.has(df)) continue; // the four hermes-* services share one image
    seen.add(df);
    if (!exists(df)) { r.fail(G, `${b.name}: ${df} does not exist`); continue; }
    const instrs = parseDockerfile(read(df));
    const ignoreFile = path.join(b.context, '.dockerignore');
    const ignore = exists(ignoreFile) ? read(ignoreFile) : '';
    const missing = [];
    const ignored = [];
    for (const { src, line } of contextCopies(instrs)) {
      if (/[*?[]/.test(src)) continue;
      const rel = path.join(b.context, src);
      if (!exists(rel)) missing.push(`${src} (line ${line})`);
      else if (ignore && dockerignored(src, ignore)) ignored.push(`${src} (line ${line})`);
    }
    r.check(G, !missing.length, `${df}: every COPY source exists in context ${b.context}`, `${df}: COPY source(s) missing: ${missing.join(', ')}`);
    r.check(G, !ignored.length, `${df}: no COPY source is excluded by .dockerignore`, `${df}: COPY source(s) excluded by ${ignoreFile}: ${ignored.join(', ')}`);
    // CMD/ENTRYPOINT TypeScript entry (tsx src/index.ts) under the last WORKDIR /app/<dir> must exist in the repo.
    let workdir = '/';
    for (const i of instrs) {
      if (i.op === 'WORKDIR') workdir = i.args.startsWith('/') ? i.args : path.posix.join(workdir, i.args);
      if (i.op !== 'CMD' && i.op !== 'ENTRYPOINT') continue;
      for (const m of i.args.matchAll(/"?([\w./-]+\.ts)"?/g)) {
        if (!workdir.startsWith('/app/')) continue;
        const rel = path.join(workdir.slice('/app/'.length), m[1]);
        r.check(G, exists(rel), `${df}: ${i.op} entry ${rel} exists`, `${df}: ${i.op} runs ${m[1]} in ${workdir} but ${rel} does not exist`);
      }
    }
  }
  // Playwright base image must match playwright-core (docs/10: bump both together).
  const worker = parseDockerfile(read('apps/worker/Dockerfile'));
  const arg = worker.find((i) => i.op === 'ARG' && i.args.startsWith('PLAYWRIGHT_VERSION='))?.args.split('=')[1];
  const core = JSON.parse(read('apps/worker/package.json')).dependencies?.['playwright-core'];
  r.check(G, !!arg && arg === core, `worker image Playwright ${arg} = playwright-core ${core}`, `worker Dockerfile PLAYWRIGHT_VERSION=${arg} but apps/worker/package.json playwright-core is ${core}`);
  // Healthcheck endpoints the images and deploy/update.sh rely on.
  r.check(G, exists('apps/dashboard/src/app/api/health/route.ts'), 'dashboard /api/health route exists (image HEALTHCHECK, uptime ping)', 'apps/dashboard/src/app/api/health/route.ts missing');
  r.check(G, /pathname === '\/health'/.test(read('apps/worker/src/http.ts')), 'worker serves /health (image HEALTHCHECK)', 'apps/worker/src/http.ts no longer serves /health');
}

// ---------- main ----------

const ICON = { ok: '✓', fail: '✗', skip: '–' };

export function runChecks(opts = {}) {
  const r = createReport();
  const compose = loadCompose(r);
  checkEnv(r, compose);
  checkComposeFiles(r, compose);
  checkDocker(r, { skip: !!opts.skipDocker });
  checkProxy(r, compose);
  checkShell(r);
  checkDockerfiles(r, compose);
  checkMigrations(r, { skip: !!opts.skipDb });
  return r.rows;
}

export function printReport(rows) {
  const groups = [...new Set(rows.map((x) => x.group))];
  console.log(`RizeHub HQ deploy readiness (offline) · ${DOMAIN}`);
  for (const g of groups) {
    console.log(`\n${g}`);
    for (const row of rows.filter((x) => x.group === g)) console.log(`  ${ICON[row.status]} ${row.msg}`);
  }
  const n = (s) => rows.filter((x) => x.status === s).length;
  console.log(`\n${n('fail') ? ICON.fail : ICON.ok} ${n('ok')} passed, ${n('fail')} failed, ${n('skip')} skipped`);
  if (!n('fail')) console.log('  Next: keys + VPS → docs/10-DEPLOY-VPS.md "Go-live runbook".');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const unknown = args.filter((a) => !['--skip-db', '--skip-docker'].includes(a));
  if (unknown.length) { console.error(`check-deploy: unknown option(s) ${unknown.join(' ')} (use --skip-db, --skip-docker)`); process.exit(2); }
  const rows = runChecks({ skipDb: args.includes('--skip-db'), skipDocker: args.includes('--skip-docker') });
  printReport(rows);
  process.exit(rows.some((x) => x.status === 'fail') ? 1 : 0);
}
