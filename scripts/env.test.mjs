// node --test scripts/env.test.mjs  (pnpm test:scripts): per-service env split + dashboard leak check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from './env-schema.mjs';
import { splitEnv } from './split-env.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MASTER = [
  'SUPABASE_URL=https://abc.supabase.co', 'SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxxxxxxxxxxxxxxxxxxxxxxx', 'NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_xxxxxxxxxxxxxxxx', 'HQ_INTERNAL_SECRET=0123456789abcdef0123456789abcdef', 'HQ_WORKER_URL=http://hq-worker:4000',
  'DASHBOARD_URL=https://hq.rizehub.ph', 'VAULT_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxx',
  'TELEGRAM_BOT_TOKEN=123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234', 'TELEGRAM_ALLOWED_USER_IDS=123456789', 'MONTHLY_BUDGET_USD=5', 'BOT_POLL_MS=5000',
  'SUPABASE_DB_URL=postgresql://u:p@h:5432/postgres', 'SHOPIFY_TOKEN_MADAM_MUSE=shpat_x', "WEIRD='a b # c'", 'TZ=Asia/Manila',
].join('\n');

test('split: dashboard never gets the service-role or vault key; bot gets Telegram + Supabase; worker the rest minus Telegram/ops', () => {
  const parts = splitEnv(parseEnv(MASTER));
  const keys = (t) => [...parseEnv(t).keys()];
  assert.deepEqual(keys(parts.dashboard).sort(), ['DASHBOARD_URL', 'HQ_INTERNAL_SECRET', 'HQ_WORKER_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL']);
  assert.deepEqual(keys(parts.bot).sort(), ['BOT_POLL_MS', 'DASHBOARD_URL', 'MONTHLY_BUDGET_USD', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'TELEGRAM_ALLOWED_USER_IDS', 'TELEGRAM_BOT_TOKEN', 'TZ']);
  const w = parseEnv(parts.worker);
  for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'VAULT_MASTER_KEY', 'GROQ_API_KEY', 'SHOPIFY_TOKEN_MADAM_MUSE', 'HQ_INTERNAL_SECRET']) assert.ok(w.has(k), k);
  for (const k of ['TELEGRAM_BOT_TOKEN', 'SUPABASE_DB_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'DASHBOARD_URL']) assert.ok(!w.has(k), k);
  assert.equal(w.get('WEIRD'), 'a b # c', 'values survive the round trip');
});

test('check-env: a dashboard file with SUPABASE_SERVICE_ROLE_KEY or VAULT_MASTER_KEY fails; the split files pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rzh-env-'));
  fs.writeFileSync(path.join(dir, '.env'), MASTER);
  execFileSync(process.execPath, [path.join(DIR, 'split-env.mjs'), '--in', path.join(dir, '.env')]);
  assert.equal(fs.statSync(path.join(dir, '.env.dashboard')).mode & 0o777, 0o600);
  const ok = spawnSync(process.execPath, [path.join(DIR, 'check-env.mjs'), '--split', '--production', '--file', path.join(dir, '.env')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
  for (const leak of ['SUPABASE_SERVICE_ROLE_KEY=', 'VAULT_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=']) {
    fs.writeFileSync(path.join(dir, 'x', '..', '.env.dashboard'), `${fs.readFileSync(path.join(dir, '.env.dashboard'), 'utf8')}${leak}\n`);
    const bad = spawnSync(process.execPath, [path.join(DIR, 'check-env.mjs'), '--file', path.join(dir, '.env.dashboard')], { encoding: 'utf8' });
    assert.equal(bad.status, 1, bad.stdout);
    assert.match(bad.stdout, new RegExp(`${leak.split('=')[0]}\\s+must NOT be in \\.env\\.dashboard`));
    execFileSync(process.execPath, [path.join(DIR, 'split-env.mjs'), '--in', path.join(dir, '.env')]);
  }
});
