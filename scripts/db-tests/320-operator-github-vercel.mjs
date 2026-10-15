// Julev Operator phase 3 M7 (supabase/migrations/20261017070000_operator_github_vercel.sql): GitHub / Vercel tokens
// are linked per client like Webflow / Airtable (only api tokens of that platform), the Vercel team is the CEO's, and
// GitHub / Vercel changes are approval-gated actions with their own titles.
export default async function ({ db, step, val, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  async function asCeo(fn) {
    await db.exec(`set role authenticated`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [CEO, JSON.stringify({ role: 'authenticated', sub: CEO, aal: 'aal2', amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  const cred = (platform, type = 'api_token') => val(`insert into client_credentials (client_id, platform, label, secret_type, secret_cipher, secret_iv)
    values ((select id from clients order by created_at limit 1), $1, $1 || ' token', $2, '\\x00'::bytea, '\\x00'::bytea) returning id`, [platform, type]);

  await step('operator github/vercel: tokens linked per platform; wrong platform or a password refused; Vercel team set', async () => {
    await db.query(`update operator_clients set client_id = null where slug = 'lvlup'`);
    const gh = await cred('github'); const vc = await cred('vercel'); const pw = await cred('github', 'password');
    await asCeo(async () => {
      await val(`select operator_set_credential('lvlup', 'github', $1)`, [gh]);
      await val(`select operator_set_credential('lvlup', 'vercel', $1)`, [vc]);
      await assert.rejects(db.query(`select operator_set_credential('lvlup', 'vercel', $1)`, [gh]), /is for github/);
      await assert.rejects(db.query(`select operator_set_credential('lvlup', 'github', $1)`, [pw]), /API token/);
      await assert.rejects(db.query(`select operator_set_credential('lvlup', 'gitlab', $1)`, [gh]), /platform must be/);
      await val(`select operator_set_vercel_team('lvlup', 'team_LvlUp01')`);
      await assert.rejects(db.query(`select operator_set_vercel_team('lvlup', 'bad team!')`), /team/);
    });
    const c = (await db.query(`select github_credential, vercel_credential, vercel_team from operator_clients where slug = 'lvlup'`)).rows[0];
    assert.deepEqual([c.github_credential, c.vercel_credential, c.vercel_team], [gh, vc, 'team_LvlUp01']);
    assert.equal((await db.query(`select * from operator_credential('lvlup', 'github')`)).rows[0].id, gh);
    assert.equal((await db.query(`select * from operator_credential('lvlup', 'vercel')`)).rows[0].id, vc);
  });

  await step('operator github/vercel: merges and promotions are approvals with their own titles', async () => {
    const jid = await val(`insert into operator_jobs (client_slug, source, title, brief, status, runs) values ('lvlup', 'ceo', 'Fix the footer link', 'Fix it', 'running', 1) returning id`);
    const r = await val(`select operator_request_action($1, 'github_merge', 'Merge PR #42 (footer link fix) into main', '{"repo":"lvlup/site","number":42}'::jsonb)`, [jid]);
    assert.match(await val(`select title from approvals where id = $1`, [r.approval_id]), /^Merge pull request \(LvlUp Ventures\): Merge PR #42/);
    const p = await val(`select operator_request_action($1, 'vercel_promote', 'Promote the fixed preview to production', '{"project":"lvlup-site","deployment_id":"dpl_abc"}'::jsonb)`, [jid]);
    assert.match(await val(`select title from approvals where id = $1`, [p.approval_id]), /^Promote to production/);
    await assert.rejects(db.query(`select operator_request_action($1, 'gitlab_merge', 'x y z')`, [jid]));
  });
}
