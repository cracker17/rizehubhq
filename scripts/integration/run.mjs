// Integration harness: real PostgreSQL + real PostgREST (+ a tiny /rest/v1 proxy standing in for Kong),
// migrations + seed + fixtures, then scripts/integration/lifecycle.ts drives the worker, bot and dashboard
// code paths through supabase-js. Everything is torn down at the end.
// Run from the repo root: pnpm test:integration   (see scripts/integration/README.md)
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HERE = import.meta.dirname;
const PGRST_VERSION = process.env.POSTGREST_VERSION ?? 'v12.2.12';
const CACHE = process.env.IT_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'rizehubhq-integration');
const DEBUG = !!process.env.IT_DEBUG;
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
export const CEO_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_ID = '22222222-2222-4222-8222-222222222222';

const cleanups = [];
let exiting = false;
async function teardown() {
  while (cleanups.length) {
    try { await cleanups.pop()(); } catch (e) { if (DEBUG) console.error('[it] cleanup:', e.message); }
  }
}
function skip(msg) { console.log(`[it] SKIPPED: ${msg}`); return teardown().then(() => process.exit(0)); }
async function fail(msg) { console.error(`[it] FAILED: ${msg}`); await teardown(); process.exit(1); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (!exiting) { exiting = true; void teardown().then(() => process.exit(130)); } });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- JWTs (HS256, like Supabase's anon / service_role keys and GoTrue access tokens) ----------
const b64url = (b) => Buffer.from(b).toString('base64url');
function jwt(claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: 'supabase', iat: now, exp: now + 3600, ...claims }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

// ---------- PostgreSQL ----------
function findPgBin() {
  const cands = [];
  if (process.env.PG_BIN) cands.push(process.env.PG_BIN);
  try { cands.push(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()); } catch { /* not installed */ }
  for (const base of ['/usr/lib/postgresql', '/usr/local/pgsql']) {
    if (fs.existsSync(base)) {
      for (const v of fs.readdirSync(base).sort((a, b) => Number(b) - Number(a))) cands.push(path.join(base, v, 'bin'));
      cands.push(path.join(base, 'bin'));
    }
  }
  return cands.find((d) => fs.existsSync(path.join(d, 'postgres')) && fs.existsSync(path.join(d, 'initdb'))) ?? null;
}

/** Postgres refuses to run as root: run its binaries as the `postgres` OS user when we are root. */
function pgUser() {
  if (process.getuid?.() !== 0) return null;
  const r = spawnSync('id', ['-u', 'postgres']);
  if (r.status === 0) return 'postgres';
  throw new Error('running as root and no "postgres" OS user exists (postgres cannot run as root)');
}
function asPg(user, bin, args) {
  return user ? ['runuser', ['-u', user, '--', bin, ...args]] : [bin, args];
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.slice(0, 3).join(' ')} … failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

async function startPostgres() {
  const bin = findPgBin();
  if (!bin) return null;
  const user = pgUser();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rizehubhq-it-'));
  const data = path.join(dir, 'data');
  const sock = path.join(dir, 'sock');
  fs.mkdirSync(sock);
  if (user) {
    fs.chmodSync(dir, 0o755);
    run('chown', ['-R', `${user}:`, dir]);
  }
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  run(...asPg(user, path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync', '-A', 'trust']));
  run(...asPg(user, path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(dir, 'pg.log'), '-w', '-o',
    `-p ${port} -k ${sock} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=50`, 'start']));
  cleanups.push(async () => { spawnSync(...asPg(user, path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'])); });
  const psqlFile = (file) => run(path.join(bin, 'psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-f', file]);
  return { bin, port, psqlFile, dir, version: run(path.join(bin, 'postgres'), ['--version']).trim() };
}

// ---------- PostgREST ----------
async function postgrestBinary() {
  if (process.env.POSTGREST_BIN) return process.env.POSTGREST_BIN;
  const onPath = spawnSync('postgrest', ['--version']);
  if (onPath.status === 0) return 'postgrest';
  if (process.platform !== 'linux' || os.arch() !== 'x64') throw new Error(`no PostgREST download for ${process.platform}/${os.arch()}; set POSTGREST_BIN`);
  const dest = path.join(CACHE, `postgrest-${PGRST_VERSION}`);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(CACHE, { recursive: true });
  const url = `https://github.com/PostgREST/postgrest/releases/download/${PGRST_VERSION}/postgrest-${PGRST_VERSION}-linux-static-x86-64.tar.xz`;
  console.log(`[it] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const tmp = fs.mkdtempSync(path.join(CACHE, 'dl-'));
  fs.writeFileSync(path.join(tmp, 'pgrst.tar.xz'), Buffer.from(await res.arrayBuffer()));
  run('tar', ['-xJf', path.join(tmp, 'pgrst.tar.xz'), '-C', tmp]);
  fs.renameSync(path.join(tmp, 'postgrest'), dest);
  fs.chmodSync(dest, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
  return dest;
}

async function startPostgrest(binPath, pgPort, dir) {
  const port = await freePort();
  const conf = path.join(dir, 'postgrest.conf');
  fs.writeFileSync(conf, [
    `db-uri = "postgres://authenticator:authenticator@127.0.0.1:${pgPort}/postgres"`,
    'db-schemas = "public"',
    'db-anon-role = "anon"',
    'db-pool = 10',
    `jwt-secret = "${JWT_SECRET}"`,
    'server-host = "127.0.0.1"',
    `server-port = ${port}`,
    `log-level = "${DEBUG ? 'info' : 'error'}"`,
  ].join('\n'));
  const proc = spawn(binPath, [conf], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; if (DEBUG) process.stdout.write(`[postgrest] ${d}`); });
  proc.stderr.on('data', (d) => { out += d; if (DEBUG) process.stderr.write(`[postgrest] ${d}`); });
  cleanups.push(async () => { proc.kill('SIGTERM'); await sleep(100); });
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`PostgREST exited:\n${out}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return port; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`PostgREST did not become ready:\n${out}`);
}

/** Kong stand-in: supabase-js talks to <url>/rest/v1/*, PostgREST serves /*. */
function startProxy(pgrstPort) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!req.url.startsWith('/rest/v1')) { res.writeHead(404).end('only /rest/v1 is served here'); return; }
      const upstream = http.request({
        host: '127.0.0.1', port: pgrstPort, method: req.method, path: req.url.slice('/rest/v1'.length) || '/',
        headers: { ...req.headers, host: `127.0.0.1:${pgrstPort}` },
      }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
      upstream.on('error', (e) => { res.writeHead(502).end(e.message); });
      req.pipe(upstream);
    });
    server.listen(0, '127.0.0.1', () => {
      cleanups.push(() => new Promise((r) => server.close(() => r())));
      resolve(server.address().port);
    });
  });
}

// ---------- main ----------
let pg;
try {
  pg = await startPostgres();
} catch (e) {
  await fail(`could not start PostgreSQL: ${e.message}`);
}
if (!pg) await skip('no PostgreSQL server binaries found (install postgresql, or set PG_BIN to its bin/ directory).');
console.log(`[it] ${pg.version} on :${pg.port}`);

let pgrstBin;
try {
  pgrstBin = await postgrestBinary();
} catch (e) {
  await skip(`PostgREST binary unavailable (${e.message}). Set POSTGREST_BIN to a local binary to run this suite.`);
}

try {
  pg.psqlFile(path.join(HERE, 'bootstrap.sql'));
  const migDir = path.join(ROOT, 'supabase/migrations');
  for (const f of fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) pg.psqlFile(path.join(migDir, f));
  pg.psqlFile(path.join(ROOT, 'supabase/seed.sql'));
  pg.psqlFile(path.join(HERE, 'fixtures.sql'));
  console.log('[it] migrations + seed + fixtures applied');
} catch (e) {
  await fail(e.message);
}

let apiPort;
try {
  const pgrstPort = await startPostgrest(pgrstBin, pg.port, pg.dir);
  apiPort = await startProxy(pgrstPort);
  const v = spawnSync(pgrstBin, ['--version'], { encoding: 'utf8' }).stdout.trim();
  console.log(`[it] ${v} on :${pgrstPort} (served at http://127.0.0.1:${apiPort}/rest/v1)`);
} catch (e) {
  await fail(e.message);
}

const env = {
  ...process.env,
  IT_SUPABASE_URL: `http://127.0.0.1:${apiPort}`,
  IT_ANON_KEY: jwt({ role: 'anon' }),
  IT_SERVICE_KEY: jwt({ role: 'service_role' }),
  IT_CEO_JWT: jwt({ sub: CEO_ID, role: 'authenticated', aud: 'authenticated', email: 'ceo@rizehub.test' }),
  IT_OTHER_JWT: jwt({ sub: OTHER_ID, role: 'authenticated', aud: 'authenticated', email: 'intern@rizehub.test' }),
  IT_PG_URL: `postgres://postgres@127.0.0.1:${pg.port}/postgres`,
  IT_PSQL: path.join(pg.bin, 'psql'),
  // the worker must never reach a real provider or RizeHub from this suite
  SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', RIZEHUB_API_URL: '', RIZEHUB_API_KEY: '',
};
const tsx = path.join(ROOT, 'apps/worker/node_modules/.bin/tsx');
if (!fs.existsSync(tsx)) await fail('apps/worker/node_modules/.bin/tsx not found: run pnpm install first');
const child = spawn(tsx, ['--tsconfig', path.join(ROOT, 'apps/dashboard/tsconfig.json'), path.join(HERE, 'lifecycle.mts')],
  { stdio: 'inherit', env, cwd: ROOT });
const code = await new Promise((r) => child.on('exit', (c, s) => r(c ?? (s ? 1 : 0))));
await teardown();
process.exit(code);
