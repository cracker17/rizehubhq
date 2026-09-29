// Internal vault / Admin → Tool logins (supabase/migrations/20260929060000_internal_vault.sql): one internal client,
// created on first call, never archived or deleted; agents see the agency's tool logins granted to them in any task
// (no client, or any client) and nothing they are not granted; every Client Vault guard still applies.
export default async function ({ db, step, val, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const CUST = 'c1500000-0000-0000-0000-000000000001';
  const SEMRUSH = 'c1500000-0000-0000-0000-00000000a001';
  const CANVA = 'c1500000-0000-0000-0000-00000000a002';
  const CUST_CRED = 'c1500000-0000-0000-0000-00000000b001';
  const nowSec = () => Math.floor(Date.now() / 1000);
  // The CEO enrolled TOTP in 120-connectors, so a CEO session must be aal2 to count as the CEO.
  async function asJwt(role, claims, fn) {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [claims.sub ?? '', JSON.stringify({ role, ...claims })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  const ceo = { sub: CEO, aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - 5 }] };
  const service = { role: 'service_role' };
  const insertCred = (id, client, platform, label, grants) => val(
    `select vault_insert_credential($1, $2, $3, $4, 'https://www.semrush.com/login/', 'team@rizehub.ph', 'password',
       '\\x0102'::bytea, '\\x0304'::bytea, 1, 'email', 'Keyword research only', '{https://www.semrush.com/analytics}', null, 'ceo', $5::text[])`,
    [id, client, platform, label, grants]);
  let ic;

  await step('internal vault: browsers other than the CEO cannot get or create the internal client', async () => {
    assert.equal(await val(`select count(*)::int from clients where is_internal`), 0);
    await as('anon', null, async () => { await assert.rejects(db.query(`select internal_client_id()`), /permission denied/); });
    await asJwt('authenticated', { sub: OTHER }, async () => { await assert.rejects(db.query(`select internal_client_id()`), /not allowed/); });
    assert.equal(await val(`select count(*)::int from clients where is_internal`), 0);
  });

  await step('internal vault: internal_client_id() creates "RizeHub (internal)" once and then returns the same row', async () => {
    await asJwt('authenticated', ceo, async () => { ic = await val(`select internal_client_id()`); });
    assert.ok(ic);
    await asJwt('service_role', service, async () => { assert.equal(await val(`select internal_client_id()`), ic); });
    assert.equal(await val(`select internal_client_id()`), ic);
    assert.equal(await val(`select count(*)::int from clients where is_internal`), 1);
    assert.equal(await val(`select name || '|' || slug || '|' || status from clients where id = $1`, [ic]), 'RizeHub (internal)|rizehub-internal|active');
    await asJwt('authenticated', ceo, async () => {
      assert.equal(await val(`select is_internal from clients where id = $1`, [ic]), true); // the dashboard can filter on it
    });
  });

  await step('internal vault: at most one internal client, and a customer can never become (or stop being) it', async () => {
    await assert.rejects(db.query(`insert into clients (name, slug, is_internal) values ('Second', 'second-internal', true)`), /duplicate|unique/);
    await db.query(`insert into clients (id, name, slug, platforms) values ($1, 'Tool Test Co', 'tool-test-co', '{shopify}')`, [CUST]);
    await assert.rejects(db.query(`update clients set is_internal = true where id = $1`, [CUST]), /cannot be changed/);
    await assert.rejects(db.query(`update clients set is_internal = false where id = $1`, [ic]), /cannot be changed/);
    assert.equal(await val(`select count(*)::int from clients where is_internal`), 1);
  });

  await step('internal vault: the internal client cannot be archived or deleted (tool logins stay safe)', async () => {
    await asJwt('authenticated', ceo, async () => {
      await assert.rejects(db.query(`update clients set status = 'archived' where id = $1`, [ic]), /cannot be archived/);
      await assert.rejects(db.query(`delete from clients where id = $1`, [ic]), /cannot be deleted/);
      await db.query(`update clients set notes = 'Agency tools' where id = $1`, [ic]); // other edits are fine
    });
    await assert.rejects(db.query(`update clients set status = 'archived' where id = $1`, [ic]), /cannot be archived/);
    assert.equal(await val(`select status from clients where id = $1`, [ic]), 'active');
  });

  await step('internal vault: the worker stores tool logins on the internal client with per-agent grants', () => asJwt('service_role', service, async () => {
    assert.equal(await insertCred(SEMRUSH, ic, 'semrush', 'Semrush · agency seat', ['web-dev', 'writer']), SEMRUSH);
    assert.equal(await insertCred(CANVA, ic, 'canva', 'Canva · team', ['designer']), CANVA);
    assert.equal(await insertCred(CUST_CRED, CUST, 'shopify', 'Tool Test Co · Shopify', ['web-dev']), CUST_CRED);
  }));

  await step('internal vault: a client-less task lists only the tool logins the agent is granted', () => asJwt('service_role', service, async () => {
    const l = await val(`select vault_list_for_agent('web-dev', null)`);
    assert.equal(l.client, null);
    assert.deepEqual(l.granted, []);
    assert.equal(l.not_granted, 0);
    assert.deepEqual(l.tools.map((c) => c.label), ['Semrush · agency seat']);
    assert.equal(l.tools_not_granted, 1); // Canva exists but is not granted to web-dev
    assert.equal(l.tools[0].secret_cipher, undefined);
    assert.deepEqual(l.tools[0].url_allowlist, ['https://www.semrush.com/analytics']);
    const d = await val(`select vault_list_for_agent('designer', null)`);
    assert.deepEqual(d.tools.map((c) => c.label), ['Canva · team']);
    const qa = await val(`select vault_list_for_agent('qa-lead', null)`);
    assert.deepEqual(qa.tools, []);
    assert.equal(qa.tools_not_granted, 2);
  }));

  await step('internal vault: a customer task gets its own logins plus the granted tool logins (no duplicates on the internal client)', () => asJwt('service_role', service, async () => {
    const l = await val(`select vault_list_for_agent('web-dev', $1)`, [CUST]);
    assert.equal(l.client.name, 'Tool Test Co');
    assert.equal(l.client.is_internal, false);
    assert.deepEqual(l.granted.map((c) => c.label), ['Tool Test Co · Shopify']);
    assert.deepEqual(l.tools.map((c) => c.label), ['Semrush · agency seat']);
    const self = await val(`select vault_list_for_agent('web-dev', $1)`, [ic]);
    assert.equal(self.client.is_internal, true);
    assert.deepEqual(self.granted.map((c) => c.label), ['Semrush · agency seat']);
    assert.deepEqual(self.tools, []);
    await assert.rejects(db.query(`select vault_list_for_agent('web-dev', 'c1500000-0000-0000-0000-0000000000ff')`), /client not found/);
  }));

  await step('internal vault: using a tool login needs the grant, whatever the task\'s client', () => asJwt('service_role', service, async () => {
    const row = (await db.query(`select * from vault_get_for_agent($1, 'writer')`, [SEMRUSH])).rows[0];
    assert.equal(row.client_id, ic);
    assert.ok(row.secret_cipher instanceof Uint8Array);
    await assert.rejects(db.query(`select * from vault_get_for_agent($1, 'web-dev')`, [CANVA]), /not granted/);
    await assert.rejects(db.query(`select * from vault_get_for_agent($1, 'qa-lead')`, [SEMRUSH]), /not granted/);
  }));

  await step('internal vault: browsers cannot list or fetch tool logins; the CEO manages grants like any credential', async () => {
    await asJwt('authenticated', ceo, async () => {
      await assert.rejects(db.query(`select vault_list_for_agent('web-dev', null)`), /permission denied/);
      await assert.rejects(db.query(`select vault_granted_meta('web-dev', $1)`, [ic]), /permission denied/);
      await assert.rejects(db.query(`select * from vault_get_for_agent($1, 'web-dev')`, [SEMRUSH]), /permission denied/);
      await assert.rejects(db.query(`select secret_cipher from client_credentials where id = $1`, [SEMRUSH]), /permission denied/);
      assert.deepEqual(await val(`select vault_set_grants($1, '{web-dev}')`, [SEMRUSH]), ['web-dev']);
    });
    await asJwt('service_role', service, async () => {
      await assert.rejects(db.query(`select * from vault_get_for_agent($1, 'writer')`, [SEMRUSH]), /not granted/);
    });
  });

  await step('internal vault: two failed logins stop agents (check needed) and every use is logged against the internal client', async () => {
    await asJwt('service_role', service, async () => {
      await db.query(`select vault_log_access($1, 'web-dev', null, 'login', true, '{"host":"www.semrush.com"}')`, [SEMRUSH]);
      await db.query(`select vault_log_access($1, 'web-dev', null, 'failed_login', false, '{}')`, [SEMRUSH]);
      await db.query(`select vault_log_access($1, 'web-dev', null, 'failed_login', false, '{}')`, [SEMRUSH]);
      await assert.rejects(db.query(`select * from vault_get_for_agent($1, 'web-dev')`, [SEMRUSH]), /check needed/);
      assert.equal((await val(`select vault_list_for_agent('web-dev', null)`)).tools[0].status, 'check_needed');
    });
    assert.equal(await val(`select status from client_credentials where id = $1`, [SEMRUSH]), 'check_needed');
    assert.equal(await val(`select count(*)::int from credential_access_log where credential_id = $1 and action in ('login','failed_login')`, [SEMRUSH]), 3);
    assert.ok(await val(`select count(*)::int from activity_log where client_id = $1 and action like 'vault.%'`, [ic]) >= 3);
  });

  await step('internal vault: a revoked tool login disappears from every agent\'s list', async () => {
    await asJwt('authenticated', ceo, async () => { await db.query(`select vault_revoke($1, 'Seat cancelled')`, [CANVA]); });
    await asJwt('service_role', service, async () => {
      const d = await val(`select vault_list_for_agent('designer', $1)`, [CUST]);
      assert.deepEqual(d.tools, []);
      assert.equal(d.tools_not_granted, 1); // only the (flagged) Semrush login is left, granted to web-dev
      await assert.rejects(db.query(`select * from vault_get_for_agent($1, 'designer')`, [CANVA]), /not granted|revoked/);
    });
  });
}
