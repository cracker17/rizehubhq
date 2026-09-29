// M13.2 (supabase/migrations/20260929040000_mcp_tools.sql): per-tool permissions of MCP connectors. First sync applies
// the worker's defaults; later new/changed tools arrive Off for review; locked tools are never Allowed; loosening needs a
// fresh 2FA code; agents only get granted, active connectors' tools that are on and reviewed.
export default async function ({ db, step, val, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const M1 = 'c0e00000-0000-0000-0000-0000000000a1';
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
  const tools = (list) => JSON.stringify(list);
  const T = (name, policy, extra = {}) => ({ name, description: `${name} tool`, input_schema: { type: 'object' }, annotations: {}, policy, locked: null, badges: [], ...extra });
  const policies = async () => Object.fromEntries((await db.query(`select name, policy || case when review_needed then '*' else '' end as p from connector_tools where connector_id = $1 order by name`, [M1])).rows.map((r) => [r.name, r.p]));

  await step('mcp tools: fixtures (an MCP connector granted to the designer, CEO has 2FA)', async () => {
    await db.exec(`create table if not exists auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null, factor_type text not null, status text not null)`);
    await db.query(`insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', 'verified')`, [CEO]);
    await asJwt('service_role', service, async () => {
      await db.query(`select connector_insert($1, 'mcp', 'Magnific', null, 'https://mcp.magnific.com', 'oauth', '{}'::jsonb, '\\x01'::bytea, '\\x02'::bytea, 1, array['designer'], 'magnific')`, [M1]);
    });
  });

  await step('mcp tools: the first sync applies the defaults; only the worker may sync', async () => {
    const list = tools([T('search_stock', 'allow'), T('generate_image', 'ask', { badges: ['credits'] }), T('call_customer', 'off', { locked: 'contact', badges: ['contact'] })]);
    await asJwt('authenticated', fresh, async () => { await assert.rejects(db.query(`select connector_tools_sync($1, $2::jsonb, true)`, [M1, list]), /permission denied/); });
    await asJwt('service_role', service, async () => { assert.equal(await val(`select connector_tools_sync($1, $2::jsonb, true)`, [M1, list]), 3); });
    assert.deepEqual(await policies(), { call_customer: 'off', generate_image: 'ask', search_stock: 'allow' });
  });

  await step('mcp tools: agents get granted tools that are on; other agents get nothing', async () => {
    await asJwt('service_role', service, async () => {
      assert.deepEqual((await db.query(`select name, policy from connector_tools_for_agent('designer') order by name`)).rows,
        [{ name: 'generate_image', policy: 'ask' }, { name: 'search_stock', policy: 'allow' }]);
      assert.equal(await val(`select count(*)::int from connector_tools_for_agent('writer')`), 0);
    });
    await asJwt('authenticated', fresh, async () => {
      await assert.rejects(db.query(`select * from connector_tools_for_agent('designer')`), /permission denied/);
      assert.equal(await val(`select count(*)::int from connector_tools`), 3, 'the CEO can read the tool list');
      await assert.rejects(db.query(`update connector_tools set policy = 'allow'`), /permission denied/);
    });
  });

  await step('mcp tools: a locked tool can never be Allowed; loosening needs a fresh code; tightening does not', async () => {
    await asJwt('authenticated', fresh, async () => {
      await assert.rejects(db.query(`select connector_set_tool_policies($1, '{"call_customer":"allow"}'::jsonb)`, [M1]), /locked \(contact\)/);
    });
    await asJwt('authenticated', stale, async () => {
      await assert.rejects(db.query(`select connector_set_tool_policies($1, '{"generate_image":"allow"}'::jsonb)`, [M1]), /step_up_required/);
      await db.query(`select connector_set_tool_policies($1, '{"search_stock":"ask"}'::jsonb)`, [M1]);
    });
    await asJwt('authenticated', fresh, async () => { await db.query(`select connector_set_tool_policies($1, '{"generate_image":"allow"}'::jsonb)`, [M1]); });
    assert.deepEqual(await policies(), { call_customer: 'off', generate_image: 'allow', search_stock: 'ask' });
  });

  await step('mcp tools: later syncs — new tools and changed descriptions arrive Off for review; removed tools go', async () => {
    const list = tools([T('search_stock', 'allow'), T('generate_image', 'ask', { description: 'Now also posts to social media' }), T('upload_asset', 'ask')]);
    await asJwt('service_role', service, async () => { await db.query(`select connector_tools_sync($1, $2::jsonb, false)`, [M1, list]); });
    assert.deepEqual(await policies(), { generate_image: 'off*', search_stock: 'ask', upload_asset: 'off*' });
    await asJwt('service_role', service, async () => {
      assert.deepEqual((await db.query(`select name from connector_tools_for_agent('designer')`)).rows, [{ name: 'search_stock' }]);
    });
    await asJwt('authenticated', stale, async () => {
      await assert.rejects(db.query(`select connector_set_tool_policies($1, '{"upload_asset":"ask"}'::jsonb)`, [M1]), /step_up_required/, 'reviewing a new tool in is loosening');
      await db.query(`select connector_set_tool_policies($1, '{"upload_asset":"off"}'::jsonb)`, [M1]);
    });
    assert.equal(await val(`select review_needed from connector_tools where connector_id = $1 and name = 'upload_asset'`, [M1]), false);
  });

  await step('mcp tools: disabling the connector hides its tools; deleting removes them', async () => {
    await asJwt('authenticated', stale, async () => { await db.query(`select connector_set_status($1, 'disabled')`, [M1]); });
    await asJwt('service_role', service, async () => { assert.equal(await val(`select count(*)::int from connector_tools_for_agent('designer')`), 0); });
    await asJwt('authenticated', stale, async () => { await db.query(`select connector_delete($1)`, [M1]); });
    assert.equal(await val(`select count(*)::int from connector_tools where connector_id = $1`, [M1]), 0);
    await db.exec(`drop table auth.mfa_factors`);
  });
}
