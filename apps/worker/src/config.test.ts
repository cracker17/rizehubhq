// Finding #1c: secrets leave process.env at startup (kept in a frozen snapshot); helpers get publicEnv().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicEnv, resetWorkerEnvForTests, scrubProcessEnv, workerEnv } from './config';

test('scrubProcessEnv: secret names removed from the live env, kept in the frozen workerEnv() snapshot', () => {
  const env: NodeJS.ProcessEnv = {
    SUPABASE_SERVICE_ROLE_KEY: 'svc', GROQ_API_KEY: 'g', GITHUB_TOKEN_DEFAULT: 'gh', SHOPIFY_TOKEN_MADAM_MUSE: 's', RIZEHUB_KEY_LEADS: 'r',
    HQ_INTERNAL_SECRET: 'h', RIZEHUB_WEBHOOK_SECRET: 'w', TELEGRAM_BOT_TOKEN: 't', SUPABASE_DB_URL: 'postgres://u:p@h/db', GOOGLE_OAUTH_REFRESH_TOKEN: 'o',
    VAULT_MASTER_KEY: 'v', PATH: '/usr/bin', NODE_ENV: 'production', AGENT_UID: '1001', TZ: 'Asia/Manila', DEV_SANDBOX_PREFIX: '["bwrap"]',
  };
  try {
    const removed = scrubProcessEnv(env);
    for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'GROQ_API_KEY', 'GITHUB_TOKEN_DEFAULT', 'SHOPIFY_TOKEN_MADAM_MUSE', 'RIZEHUB_KEY_LEADS', 'HQ_INTERNAL_SECRET',
      'RIZEHUB_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN', 'SUPABASE_DB_URL', 'GOOGLE_OAUTH_REFRESH_TOKEN']) {
      assert.ok(removed.includes(k), k);
      assert.equal(env[k], undefined, k);
    }
    for (const k of ['PATH', 'NODE_ENV', 'AGENT_UID', 'TZ', 'DEV_SANDBOX_PREFIX']) assert.ok(env[k], k);
    assert.equal(env.VAULT_MASTER_KEY, undefined, 'vault key is scrubbed from the live env too');
    assert.equal(workerEnv().VAULT_MASTER_KEY, 'v', 'and still readable through workerEnv()');
    assert.equal(workerEnv().GROQ_API_KEY, 'g');
    assert.equal(workerEnv().HQ_INTERNAL_SECRET, 'h');
    assert.ok(Object.isFrozen(workerEnv()));
    const pub = publicEnv(workerEnv());
    assert.equal(pub.GROQ_API_KEY, undefined);
    assert.equal(pub.VAULT_MASTER_KEY, undefined);
    assert.equal(pub.PATH, '/usr/bin');
  } finally { resetWorkerEnvForTests(); }
  assert.equal(workerEnv(), process.env);
});
