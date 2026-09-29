// Admin → API & AI (supabase/migrations/20260929070000_provider_keys.sql): provider keys are stored sealed by the worker
// only, the browser reads names + last 4 characters but never the ciphertext, only allowlisted names fit, the CEO's delete
// is audited, and AI settings change only through ai_settings_set() where raising a budget needs a fresh 2FA code.
export default async function ({ db, step, val, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const nowSec = () => Math.floor(Date.now() / 1000);
  async function asJwt(role, claims, fn) {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [claims.sub ?? '', JSON.stringify({ role, ...claims })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  const stale = { sub: CEO, aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - 3600 }] };
  const fresh = { sub: CEO, aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - 5 }] };
  const service = { role: 'service_role' };
  const upsert = (name, last4 = 'wxyz', ok = null) => db.query(
    `select provider_key_upsert($1, '\\x0102'::bytea, '\\x0304'::bytea, 1, $2, $3, null)`, [name, last4, ok]);
  const set = (profile, monthly, daily, ids = {}) => val(
    `select ai_settings_set($1, $2, $3, $4::jsonb)`, [profile, monthly, daily, JSON.stringify(ids)]);
  const aiRows = async () => Object.fromEntries((await db.query(`select key, value from settings where key like 'ai\\_%' order by key`)).rows.map((r) => [r.key, r.value]));

  await step('provider keys: fixtures (the CEO has a verified TOTP factor)', async () => {
    await db.exec(`create table if not exists auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null, factor_type text not null, status text not null)`);
    await db.query(`insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', 'verified')`, [CEO]);
  });

  await step('provider keys: only the worker stores a sealed key; anon, other users and the CEO cannot', async () => {
    await as('anon', null, async () => { await assert.rejects(upsert('GROQ_API_KEY'), /permission denied/); });
    await asJwt('authenticated', fresh, async () => {
      await assert.rejects(upsert('GROQ_API_KEY'), /permission denied/);
      await assert.rejects(db.query(`insert into provider_keys (name, cipher, iv, key_version, last4) values ('GROQ_API_KEY', '\\x01', '\\x02', 1, 'abcd')`), /permission denied/);
    });
    await asJwt('service_role', service, async () => { await upsert('GROQ_API_KEY', 'abcd', true); await upsert('ANTHROPIC_API_KEY', '9f3k'); });
    assert.equal(await val(`select count(*)::int from activity_log where action = 'provider_key.added' and detail->>'name' = 'GROQ_API_KEY'`), 1);
    await asJwt('service_role', service, async () => { await upsert('GROQ_API_KEY', 'efgh', false); });
    assert.equal(await val(`select count(*)::int from activity_log where action = 'provider_key.replaced' and detail->>'name' = 'GROQ_API_KEY'`), 1);
    assert.deepEqual(await val(`select jsonb_build_object('l', last4, 'ok', last_test_ok) from provider_keys where name = 'GROQ_API_KEY'`), { l: 'efgh', ok: false });
  });

  await step('provider keys: only allowlisted provider names fit; bootstrap secrets are refused', async () => {
    await asJwt('service_role', service, async () => {
      for (const bad of ['SUPABASE_SERVICE_ROLE_KEY', 'VAULT_MASTER_KEY', 'HQ_INTERNAL_SECRET', 'TELEGRAM_BOT_TOKEN', 'SUPABASE_DB_URL',
        'RIZEHUB_WEBHOOK_SECRET', 'HQ_MCP_TOKEN_WEB_DEV', 'groq_api_key', 'ANYTHING_ELSE']) {
        await assert.rejects(upsert(bad), /check constraint|violates/, bad);
      }
    });
    assert.equal(await val(`select count(*)::int from provider_keys`), 2);
  });

  await step('provider keys: the CEO reads name, last 4 and the test result, never the ciphertext', async () => {
    await asJwt('authenticated', stale, async () => {
      assert.deepEqual(await val(`select array_agg(name || ':' || last4 order by name) from provider_keys`), ['ANTHROPIC_API_KEY:9f3k', 'GROQ_API_KEY:efgh']);
      await assert.rejects(db.query(`select cipher from provider_keys`), /permission denied/);
      await assert.rejects(db.query(`select iv from provider_keys`), /permission denied/);
      await assert.rejects(db.query(`select * from provider_keys_sealed()`), /permission denied/);
      await assert.rejects(db.query(`select provider_key_mark_test('GROQ_API_KEY', true)`), /permission denied/);
      await assert.rejects(db.query(`update provider_keys set last4 = 'xxxx'`), /permission denied/);
      await assert.rejects(db.query(`delete from provider_keys`), /permission denied/);
    });
    await asJwt('authenticated', { sub: OTHER }, async () => {
      assert.equal(await val(`select count(*)::int from provider_keys`), 0, 'RLS: another user sees nothing');
    });
    await as('anon', null, async () => { await assert.rejects(db.query(`select name from provider_keys`), /permission denied/); });
  });

  await step('provider keys: the worker reads the sealed keys and records test results', async () => {
    await asJwt('service_role', service, async () => {
      assert.deepEqual(await val(`select array_agg(name || '=' || encode(cipher, 'hex') order by name) from provider_keys_sealed()`), ['ANTHROPIC_API_KEY=0102', 'GROQ_API_KEY=0102']);
      await db.query(`select provider_key_mark_test('GROQ_API_KEY', false, 'Groq said 401')`);
    });
    assert.equal(await val(`select last_error from provider_keys where name = 'GROQ_API_KEY'`), 'Groq said 401');
    await asJwt('service_role', service, async () => { await db.query(`select provider_key_mark_test('GROQ_API_KEY', true)`); });
    assert.deepEqual(await val(`select jsonb_build_object('ok', last_test_ok, 'e', last_error) from provider_keys where name = 'GROQ_API_KEY'`), { ok: true, e: null });
  });

  await step('provider keys: the CEO removes a key (audited); another user and anon cannot', async () => {
    await asJwt('authenticated', { sub: OTHER }, async () => { await assert.rejects(db.query(`select provider_key_delete('GROQ_API_KEY')`), /not allowed/); });
    await as('anon', null, async () => { await assert.rejects(db.query(`select provider_key_delete('GROQ_API_KEY')`), /permission denied/); });
    await asJwt('authenticated', stale, async () => {
      await db.query(`select provider_key_delete('GROQ_API_KEY')`);
      await assert.rejects(db.query(`select provider_key_delete('GROQ_API_KEY')`), /no key stored/);
    });
    assert.equal(await val(`select count(*)::int from provider_keys where name = 'GROQ_API_KEY'`), 0);
    assert.equal(await val(`select count(*)::int from activity_log where action = 'provider_key.removed' and detail->>'name' = 'GROQ_API_KEY'`), 1);
  });

  await step('AI settings: the CEO cannot write the ai_* settings rows directly (other rows still work)', async () => {
    await asJwt('authenticated', fresh, async () => {
      await assert.rejects(db.query(`insert into settings (key, value) values ('ai_monthly_budget_usd', '500')`), /row-level security/);
      await db.query(`insert into settings (key, value) values ('hq_test_setting', '1') on conflict (key) do update set value = excluded.value`);
    });
    assert.equal(await val(`select count(*)::int from settings where key = 'ai_monthly_budget_usd'`), 0);
    await db.exec(`delete from settings where key = 'hq_test_setting'`);
  });

  await step('AI settings: setting a budget where none was set needs a fresh 2FA code; a profile change alone does not', async () => {
    await asJwt('authenticated', stale, async () => {
      await set('hybrid', null, null, { qa: 'openai:gpt-5.5' });
      await assert.rejects(set('hybrid', 25, null), /step_up_required/);
      await assert.rejects(set('hybrid', null, 5), /step_up_required/);
      await set('hybrid', 0, null, { qa: 'openai:gpt-5.5' }); // 0/month is the floor: never loosens
    });
    assert.deepEqual(await aiRows(), { ai_model_ids: { qa: 'openai:gpt-5.5' }, ai_model_profile: 'hybrid', ai_monthly_budget_usd: 0 });
    await asJwt('authenticated', fresh, async () => { await set('hybrid', 40, 3, { qa: 'openai:gpt-5.5' }); });
    assert.deepEqual(await aiRows(), { ai_daily_budget_usd: 3, ai_model_ids: { qa: 'openai:gpt-5.5' }, ai_model_profile: 'hybrid', ai_monthly_budget_usd: 40 });
  });

  await step('AI settings: lowering needs no code; raising, clearing (back to .env) and daily 0 (no cap) do', async () => {
    await asJwt('authenticated', stale, async () => {
      await set('claude', 20, 2, {});
      await assert.rejects(set('claude', 30, 2), /step_up_required/, 'higher monthly');
      await assert.rejects(set('claude', 20, 4), /step_up_required/, 'higher daily');
      await assert.rejects(set('claude', 20, 0), /step_up_required/, 'daily 0 = no cap');
      await assert.rejects(set('claude', null, 2), /step_up_required/, 'clearing monthly → the .env value may be higher');
    });
    assert.deepEqual(await aiRows(), { ai_daily_budget_usd: 2, ai_model_profile: 'claude', ai_monthly_budget_usd: 20 });
    await asJwt('authenticated', fresh, async () => { await set(null, null, null, {}); });
    assert.deepEqual(await aiRows(), {}, 'everything back to the .env defaults');
    assert.ok(await val(`select count(*)::int from activity_log where action = 'ai_settings.updated'`) >= 4);
    assert.deepEqual(await val(`select detail->'before'->'ai_model_profile' from activity_log where action = 'ai_settings.updated' order by created_at desc, id desc limit 1`), 'claude');
  });

  await step('AI settings: bad input is refused; other users and anon cannot call it', async () => {
    await asJwt('authenticated', fresh, async () => {
      await assert.rejects(set('turbo', null, null), /unknown model profile/);
      await assert.rejects(set(null, -1, null), /between 0 and 100000/);
      await assert.rejects(set(null, null, 1e6), /between 0 and 100000/);
      await assert.rejects(set(null, null, null, { boss: 'openai:gpt-5.5' }), /unknown role/);
      await assert.rejects(set(null, null, null, { qa: 'gpt-5.5' }), /provider:model/);
      await assert.rejects(set(null, null, null, { qa: 'openai:gpt 5' }), /provider:model/);
      await set(null, null, null, { lead: 'openrouter:qwen/qwen3.8-27b:free' });
    });
    await asJwt('authenticated', { sub: OTHER }, async () => { await assert.rejects(set(null, null, null), /not allowed/); });
    await as('anon', null, async () => { await assert.rejects(set(null, null, null), /permission denied/); });
    await asJwt('authenticated', fresh, async () => { await set(null, null, null, {}); });
  });

  await step('provider keys: function privileges (worker-only vs CEO) and search_path', async () => {
    for (const f of ['provider_key_upsert(text,bytea,bytea,integer,text,boolean,text)', 'provider_key_mark_test(text,boolean,text)', 'provider_keys_sealed()',
      'ai_budget_looser(numeric,numeric,boolean)', 'ai_setting_num(text)']) {
      assert.deepEqual(await val(`select array[has_function_privilege('authenticated', $1::regprocedure, 'execute'),
        has_function_privilege('anon', $1::regprocedure, 'execute'), has_function_privilege('service_role', $1::regprocedure, 'execute')]`, [f]), [false, false, true], f);
    }
    for (const f of ['provider_key_delete(text)', 'ai_settings_set(text,numeric,numeric,jsonb)']) {
      assert.deepEqual(await val(`select array[has_function_privilege('authenticated', $1::regprocedure, 'execute'),
        has_function_privilege('anon', $1::regprocedure, 'execute')]`, [f]), [true, false], f);
    }
    await db.exec(`drop table auth.mfa_factors`);
  });
}
