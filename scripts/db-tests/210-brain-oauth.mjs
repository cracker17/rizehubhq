// HQ Brain connector OAuth (supabase/migrations/20260930020000_brain_oauth.sql, docs/16-BRAIN.md): only the brain
// service (service role) registers clients, issues codes and tokens; nobody else can read the tables; codes are
// one-time; a replayed refresh token revokes its family; the CEO lists and revokes connections.
export default async function ({ db, step, val, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const nowSec = () => Math.floor(Date.now() / 1000);
  async function asJwt(role, claims, fn) {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [claims.sub ?? '', JSON.stringify({ role, ...claims })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  const ceo = { sub: CEO, aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - 5 }] };
  const j = (v) => JSON.stringify(v);
  const h = (c) => c.repeat(64);
  const CLIENT = 'hqbc_testclient0000000000';

  await step('brain oauth: the service registers a client, issues a code and redeems it once', () => asJwt('service_role', { role: 'service_role' }, async () => {
    const c = await val(`select brain_oauth_register($1::jsonb)`, [j({ client_id: CLIENT, client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })]);
    assert.equal(c.client_name, 'Claude');
    await db.query(`select brain_oauth_issue_code($1::jsonb)`, [j({ code_hash: h('a'), client_id: CLIENT, user_id: CEO, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'x'.repeat(43), scopes: ['brain:read'], ttl_seconds: 300 })]);
    const r = await val(`select brain_oauth_redeem_code($1, $2)`, [h('a'), CLIENT]);
    assert.equal(r.user_id, CEO);
    assert.ok(r.family_id);
    await db.query(`select brain_token_issue($1::jsonb)`, [j({ family_id: r.family_id, client_id: CLIENT, user_id: CEO, scopes: ['brain:read'], access: { hash: h('b'), ttl_seconds: 3600 }, refresh: { hash: h('c'), ttl_seconds: 86400 } })]);
    assert.equal((await val(`select brain_token_check($1)`, [h('b')])).subject, 'ceo');
    // Second redemption: refused, and the tokens it produced are revoked.
    assert.equal(await val(`select brain_oauth_redeem_code($1, $2)`, [h('a'), CLIENT]), null);
    assert.equal(await val(`select brain_token_check($1)`, [h('b')]), null);
  }));

  await step('brain oauth: a code is only issued for the CEO', () => asJwt('service_role', { role: 'service_role' }, async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    await assert.rejects(db.query(`select brain_oauth_issue_code($1::jsonb)`, [j({ code_hash: h('d'), client_id: CLIENT, user_id: other, redirect_uri: 'https://claude.ai/x', code_challenge: 'y'.repeat(43), scopes: ['brain:read'] })]), /not the CEO/);
  }));

  await step('brain oauth: refresh rotation; replay revokes the family', () => asJwt('service_role', { role: 'service_role' }, async () => {
    const fam = '44444444-4444-4444-8444-444444444444';
    await db.query(`select brain_token_issue($1::jsonb)`, [j({ family_id: fam, client_id: CLIENT, user_id: CEO, scopes: ['brain:read', 'brain:write'], access: { hash: h('e'), ttl_seconds: 3600 }, refresh: { hash: h('f'), ttl_seconds: 86400 } })]);
    const r = await val(`select brain_token_refresh($1, $2)`, [h('f'), CLIENT]);
    assert.equal(r.family_id, fam);
    assert.equal(await val(`select brain_token_check($1)`, [h('e')]), null); // old access token revoked by the rotation
    await db.query(`select brain_token_issue($1::jsonb)`, [j({ family_id: fam, client_id: CLIENT, user_id: CEO, scopes: r.scopes, access: { hash: h('1'), ttl_seconds: 3600 }, refresh: { hash: h('2'), ttl_seconds: 86400 } })]);
    assert.ok(await val(`select brain_token_check($1)`, [h('1')]));
    assert.equal(await val(`select brain_token_refresh($1, $2)`, [h('f'), CLIENT]), null); // replay
    assert.equal(await val(`select brain_token_check($1)`, [h('1')]), null);
    assert.equal(await val(`select brain_token_refresh($1, $2)`, [h('2'), CLIENT]), null);
  }));

  await step('brain oauth: anon and signed-in users can neither call the service functions nor read the tables', async () => {
    for (const role of ['anon', 'authenticated']) {
      await asJwt(role, role === 'authenticated' ? ceo : {}, async () => {
        await assert.rejects(db.query(`select brain_token_check($1)`, [h('1')]), /permission denied/);
        await assert.rejects(db.query(`select brain_oauth_client($1)`, [CLIENT]), /permission denied/);
        await assert.rejects(db.query(`select * from brain_tokens`), /permission denied/);
        await assert.rejects(db.query(`select * from brain_oauth_clients`), /permission denied/);
      });
    }
  });

  await step('brain oauth: the CEO lists live connections and revokes one', async () => {
    const fam = '55555555-5555-4555-8555-555555555555';
    await asJwt('service_role', { role: 'service_role' }, async () => {
      await db.query(`select brain_token_issue($1::jsonb)`, [j({ family_id: fam, client_id: CLIENT, user_id: CEO, scopes: ['brain:read'], access: { hash: h('7'), ttl_seconds: 3600 }, refresh: { hash: h('8'), ttl_seconds: 86400 } })]);
    });
    await asJwt('authenticated', ceo, async () => {
      const list = await val(`select brain_connections()`);
      assert.ok(list.some((c) => c.family_id === fam && c.client_name === 'Claude'));
      assert.equal(await val(`select brain_revoke_connection($1::uuid)`, [fam]), 2);
    });
    await asJwt('anon', {}, async () => {
      await assert.rejects(db.query(`select brain_connections()`), /permission denied/);
    });
    await asJwt('service_role', { role: 'service_role' }, async () => {
      assert.equal(await val(`select brain_token_check($1)`, [h('7')]), null);
    });
  });
}
