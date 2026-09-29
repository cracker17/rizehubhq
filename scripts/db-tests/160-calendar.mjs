// Google Calendar over its secret iCal address (supabase/migrations/20260929090000_calendar_ical.sql): kind 'ical' goes
// through the existing connector functions; the sealed address is only for the worker, and only for granted agents.
export default async function ({ db, step, val, assert }) {
  const CAL = 'ca1e0000-0000-0000-0000-000000000001';
  async function asRole(role, fn) {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claims','',false);`);
    }
  }
  const insert = (id, kind) => db.query(
    `select connector_insert($1, $2, 'CEO calendar', null, null, 'none', '{"timezone":"Asia/Manila"}'::jsonb,
                             '\\x0a0b'::bytea, '\\x0c0d'::bytea, 1, array['coo'], 'google_calendar')`, [id, kind]);

  await step('calendar: the worker stores an ical connector through connector_insert (url stays null)', async () => {
    await asRole('service_role', async () => { await insert(CAL, 'ical'); });
    assert.equal(await val(`select kind from connectors where id = $1`, [CAL]), 'ical');
    assert.equal(await val(`select url from connectors where id = $1`, [CAL]), null);
    assert.equal(await val(`select auth_type from connectors where id = $1`, [CAL]), 'none');
  });

  await step('calendar: connectors_for_agent(…, \'ical\') returns it sealed for granted agents only', async () => {
    await asRole('service_role', async () => {
      assert.equal(await val(`select count(*)::int from connectors_for_agent('coo', 'ical')`), 1);
      assert.equal(await val(`select encode(secret_cipher, 'hex') from connectors_for_agent('coo', 'ical')`), '0a0b');
      assert.equal(await val(`select count(*)::int from connectors_for_agent('writer', 'ical')`), 0);
      assert.equal(await val(`select count(*)::int from connectors_for_agent('coo', 'gmail') where id = $1`, [CAL]), 0);
    });
  });

  await step('calendar: the kind list allows gmail, mcp, storage and ical, nothing else', async () => {
    await asRole('service_role', async () => {
      await assert.rejects(insert('ca1e0000-0000-0000-0000-000000000002', 'caldav'), /connectors_kind_check/);
    });
    const def = await val(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'connectors_kind_check'`);
    for (const k of ['gmail', 'mcp', 'storage', 'ical']) assert.match(def, new RegExp(`'${k}'`));
  });

  await step('calendar: disabling it hides it from agents; deleting it removes the grants', async () => {
    await db.query(`update connectors set status = 'disabled' where id = $1`, [CAL]);
    await asRole('service_role', async () => {
      assert.equal(await val(`select count(*)::int from connectors_for_agent('coo', 'ical')`), 0);
    });
    await db.query(`delete from connectors where id = $1`, [CAL]);
    assert.equal(await val(`select count(*)::int from connector_grants where connector_id = $1`, [CAL]), 0);
  });
}
