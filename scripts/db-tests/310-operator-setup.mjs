// Julev Operator phase 3 M6c (supabase/migrations/20261017060000_operator_setup.sql): the CEO adds / updates a client
// from the wizard (profile = slug, default names, rules kept when left empty) and asks for a login check that the
// operator takes once.
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

  await step('operator setup: the CEO adds a client (profile = short name, default names); an update keeps the rules', async () => {
    await asCeo(async () => {
      assert.equal(await val(`select operator_save_client('Madam-Muse', 'Madam Muse', 'madam-muse', '{}', '- No discounts without Julev')`), 'madam-muse');
      await assert.rejects(db.query(`select operator_save_client('Madam Muse', 'x', null, '{}', '')`), /short name/);
      await assert.rejects(db.query(`select operator_save_client('mm', '', null, '{}', '')`), /give the client a name/);
      await assert.rejects(db.query(`select operator_save_client('mm', 'MM', 'Bad Project', '{}', '')`), /brain project/);
      await val(`select operator_save_client('madam-muse', 'Madam Muse PH', 'madam-muse', '{"Julev", " "}', '')`);
    });
    const c = (await db.query(`select name, profile, my_names, rules, reply_when from operator_clients where slug = 'madam-muse'`)).rows[0];
    assert.deepEqual([c.name, c.profile, c.my_names, c.rules, c.reply_when], ['Madam Muse PH', 'madam-muse', ['Julev'], '- No discounts without Julev', 'addressed']);
    await db.exec(`set role anon`);
    try { await assert.rejects(db.query(`select operator_save_client('x', 'X', null, '{}', '')`)); } finally { await db.exec(`reset role`); }
  });

  await step('operator setup: "Check now" is taken once by the operator', async () => {
    await asCeo(async () => { await val(`select operator_request_login_check('madam-muse')`); await assert.rejects(db.query(`select operator_take_login_checks()`)); });
    assert.deepEqual(await val(`select operator_take_login_checks()`), ['madam-muse']);
    assert.deepEqual(await val(`select operator_take_login_checks()`), []);
  });
}
