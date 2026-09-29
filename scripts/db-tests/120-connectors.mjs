// M13 Connectors (supabase/migrations/20260929020000_connectors.sql): the worker stores sealed secrets, the CEO reads
// metadata only, loosening access (more agents, Gmail read + draft, re-enabling) needs a fresh 2FA code, all audited.
export default async function ({ db, step, val, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const G1 = 'c0e00000-0000-0000-0000-000000000001';
  const nowSec = () => Math.floor(Date.now() / 1000);
  async function asJwt(role, claims, fn) {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [claims.sub ?? '', JSON.stringify({ role, ...claims })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  const stale = { sub: CEO, aal: 'aal2', amr: [{ method: 'password', timestamp: nowSec() - 7200 }, { method: 'totp', timestamp: nowSec() - 3600 }] };
  const fresh = { sub: CEO, aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - 5 }] };
  const service = { role: 'service_role' };
  const insert = (id, email, grants, mode = 'read') => db.query(
    `select connector_insert($1, 'gmail', $2, $2, null, 'app_password', $3::jsonb, '\\x0102'::bytea, '\\x0304'::bytea, 1, $4, 'gmail')`,
    [id, email, JSON.stringify({ mode }), grants]);

  await step('connectors: fixtures (CEO has a verified TOTP factor)', async () => {
    await db.exec(`create table if not exists auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null, factor_type text not null, status text not null)`);
    await db.query(`insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', 'verified')`, [CEO]);
  });

  await step('connectors: only the worker stores a sealed secret; anon and the CEO cannot', async () => {
    await as('anon', null, async () => { await assert.rejects(insert(G1, 'x@gmail.com', ['sales']), /permission denied/); });
    await asJwt('authenticated', fresh, async () => { await assert.rejects(insert(G1, 'x@gmail.com', ['sales']), /permission denied/); });
    await asJwt('service_role', service, async () => { await insert(G1, 'Julev@Gmail.com', ['sales', 'no-such-agent']); });
    assert.deepEqual(await val(`select array_agg(agent_id) from connector_grants where connector_id = $1`, [G1]), ['sales']);
    assert.equal(await val(`select account_email from connectors where id = $1`, [G1]), 'julev@gmail.com');
    assert.equal(await val(`select count(*)::int from activity_log where action = 'connector.added' and detail->>'connector_id' = $1`, [G1]), 1);
    await asJwt('service_role', service, async () => {
      await assert.rejects(insert('c0e00000-0000-0000-0000-000000000002', 'JULEV@gmail.com', []), /duplicate|unique/);
    });
  });

  await step('connectors: the CEO sees metadata but never the ciphertext, and cannot write the tables directly', async () => {
    await asJwt('authenticated', stale, async () => {
      assert.equal(await val(`select name from connectors where id = $1`, [G1]), 'Julev@Gmail.com');
      await assert.rejects(db.query(`select secret_cipher from connectors`), /permission denied/);
      await assert.rejects(db.query(`update connectors set status = 'active'`), /permission denied/);
      await assert.rejects(db.query(`insert into connector_grants values ($1, 'coo')`, [G1]), /permission denied/);
      await assert.rejects(db.query(`select * from connectors_for_agent('sales', 'gmail')`), /permission denied/);
    });
  });

  await step('connectors: the worker gets the sealed secret only for granted agents and active connectors', async () => {
    await asJwt('service_role', service, async () => {
      assert.equal(await val(`select count(*)::int from connectors_for_agent('sales', 'gmail')`), 1);
      assert.equal(await val(`select count(*)::int from connectors_for_agent('writer', 'gmail')`), 0);
      assert.equal(await val(`select encode(secret_cipher, 'hex') from connector_get_sealed($1)`, [G1]), '0102');
    });
  });

  await step('connectors: adding an agent needs a fresh 2FA code; removing one does not', async () => {
    await asJwt('authenticated', stale, async () => {
      await assert.rejects(db.query(`select connector_set_grants($1, array['sales','coo'])`, [G1]), /step_up_required/);
    });
    await asJwt('authenticated', fresh, async () => { await db.query(`select connector_set_grants($1, array['sales','coo'])`, [G1]); });
    await asJwt('authenticated', stale, async () => { await db.query(`select connector_set_grants($1, array['coo'])`, [G1]); });
    assert.deepEqual(await val(`select array_agg(agent_id order by agent_id) from connector_grants where connector_id = $1`, [G1]), ['coo']);
  });

  await step('connectors: raising a Gmail level (read → draft → send) needs a fresh code, lowering does not; unknown modes refused', async () => {
    await asJwt('authenticated', stale, async () => {
      await assert.rejects(db.query(`select connector_update($1, 'Main inbox', '{"mode":"read_draft"}'::jsonb)`, [G1]), /step_up_required/);
      await assert.rejects(db.query(`select connector_update($1, 'Main inbox', '{"mode":"send"}'::jsonb)`, [G1]), /bad mode/);
      await db.query(`select connector_update($1, 'Main inbox', '{"mode":"read"}'::jsonb)`, [G1]);
    });
    await asJwt('authenticated', fresh, async () => { await db.query(`select connector_update($1, 'Main inbox', '{"mode":"read_draft"}'::jsonb)`, [G1]); });
    assert.equal(await val(`select settings->>'mode' from connectors where id = $1`, [G1]), 'read_draft');
    await asJwt('authenticated', stale, async () => {
      await assert.rejects(db.query(`select connector_update($1, 'Main inbox', '{"mode":"read_draft_send"}'::jsonb)`, [G1]), /step_up_required/, 'send is a higher level');
    });
    await asJwt('authenticated', fresh, async () => { await db.query(`select connector_update($1, 'Main inbox', '{"mode":"read_draft_send"}'::jsonb)`, [G1]); });
    await asJwt('authenticated', stale, async () => { await db.query(`select connector_update($1, 'Main inbox', '{"mode":"read_draft"}'::jsonb)`, [G1]); });
    assert.equal(await val(`select settings->>'mode' from connectors where id = $1`, [G1]), 'read_draft', 'lowering needs no code');
    assert.equal(await val(`select name from connectors where id = $1`, [G1]), 'Main inbox');
  });

  await step('connectors: disabling hides it from agents at once; re-enabling needs a fresh code', async () => {
    await asJwt('authenticated', stale, async () => { await db.query(`select connector_set_status($1, 'disabled')`, [G1]); });
    await asJwt('service_role', service, async () => {
      assert.equal(await val(`select count(*)::int from connectors_for_agent('coo', 'gmail')`), 0);
      await db.query(`select connector_mark($1, 'active', null, true)`, [G1]);
    });
    assert.equal(await val(`select status from connectors where id = $1`, [G1]), 'disabled', 'a worker check never re-enables');
    await asJwt('authenticated', stale, async () => {
      await assert.rejects(db.query(`select connector_set_status($1, 'active')`, [G1]), /step_up_required/);
    });
    await asJwt('authenticated', fresh, async () => { await db.query(`select connector_set_status($1, 'active')`, [G1]); });
  });

  await step('connectors: a failed login is recorded for the CEO; a good one clears it', async () => {
    await asJwt('service_role', service, async () => {
      await db.query(`select connector_mark($1, 'needs_reauth', 'Google rejected the App Password', false)`, [G1]);
    });
    assert.deepEqual(await val(`select jsonb_build_object('s', status, 'e', last_error) from connectors where id = $1`, [G1]),
      { s: 'needs_reauth', e: 'Google rejected the App Password' });
    await asJwt('service_role', service, async () => {
      assert.equal(await val(`select count(*)::int from connectors_for_agent('coo', 'gmail')`), 0, 'needs_reauth is not handed to agents');
      await db.query(`select connector_rotate_secret($1, '\\x0506'::bytea, '\\x0708'::bytea, 1)`, [G1]);
      assert.equal(await val(`select count(*)::int from connectors_for_agent('coo', 'gmail')`), 1);
    });
    assert.equal(await val(`select last_error from connectors where id = $1`, [G1]), null);
  });

  await step('connectors: removing deletes the grants and is audited', async () => {
    await asJwt('authenticated', stale, async () => { await db.query(`select connector_delete($1)`, [G1]); });
    assert.equal(await val(`select count(*)::int from connector_grants where connector_id = $1`, [G1]), 0);
    assert.equal(await val(`select count(*)::int from activity_log where action like 'connector.%' and detail->>'connector_id' = $1`, [G1]) >= 6, true);
    await db.exec(`drop table auth.mfa_factors`);
  });
}
