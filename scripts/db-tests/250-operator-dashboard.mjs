// Julev Operator phase 3 M1 (supabase/migrations/20261017000000_operator_dashboard.sql): the CEO edits the autonomy
// rules per client (inherit = back to the default), risky action types can never be set to auto, credentials stay
// never, the auto-send switch is logged; nobody but the CEO can change either; the drafter follows the new rules.
export default async function ({ db, step, val, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  async function asUser(id, fn) {
    await db.exec(`set role authenticated`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [id, JSON.stringify({ role: 'authenticated', sub: id, aal: 'aal2', amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  const mode = (c, a) => val(`select operator_mode_for($1, $2)`, [c, a]);

  await step('operator dashboard: the CEO sets per-client autonomy; inherit falls back to the default', async () => {
    await asUser(CEO, async () => {
      assert.equal(await val(`select operator_set_autonomy('lvlup', 'factual', 'auto')`), 'auto');
      assert.equal(await val(`select operator_set_autonomy('lvlup', 'ack', 'approve')`), 'approve');
      assert.equal(await val(`select operator_set_autonomy('*', 'thanks', 'approve')`), 'approve');
    });
    assert.equal(await mode('lvlup', 'factual'), 'auto');
    assert.equal(await mode('lvlup', 'ack'), 'approve');
    assert.equal(await mode('lvlup', 'status'), 'auto', 'untouched types keep the default');
    await asUser(CEO, async () => {
      assert.equal(await val(`select operator_set_autonomy('lvlup', 'ack', 'inherit')`), 'auto');
      await val(`select operator_set_autonomy('*', 'thanks', 'auto')`);
    });
    assert.equal(await val(`select count(*)::int from operator_autonomy where client_slug = 'lvlup' and action_type = 'ack'`), 0);
    assert.equal(await val(`select count(*)::int from operator_actions where action = 'autonomy.changed'`), 5);
    assert.equal(await val(`select detail ->> 'before' from operator_actions where action = 'autonomy.changed' order by id limit 1`), 'approve');
  });

  await step('operator dashboard: risky types never auto, credentials stay never, bad input refused', async () => {
    await asUser(CEO, async () => {
      for (const t of ['publish', 'money', 'delete', 'commitment', 'deadline', 'new_contact', 'credentials']) {
        await assert.rejects(db.query(`select operator_set_autonomy('lvlup', $1, 'auto')`, [t]), /never post by itself/, t);
      }
      await assert.rejects(db.query(`select operator_set_autonomy('lvlup', 'credentials', 'approve')`), /credentials stay never/);
      await assert.rejects(db.query(`select operator_set_autonomy('*', 'reply', 'inherit')`), /cannot inherit/);
      await assert.rejects(db.query(`select operator_set_autonomy('nope', 'reply', 'auto')`), /unknown client/);
      await assert.rejects(db.query(`select operator_set_autonomy('lvlup', 'gossip', 'auto')`), /unknown action type/);
      await assert.rejects(db.query(`select operator_set_autonomy('lvlup', 'reply', 'sometimes')`), /mode must be/);
      assert.equal(await val(`select operator_set_autonomy('lvlup', 'money', 'never')`), 'never');
    });
    assert.equal(await mode('lvlup', 'credentials'), 'never');
  });

  await step('operator dashboard: the auto-send switch is the CEO\'s; others cannot touch either function', async () => {
    await asUser(CEO, async () => { assert.equal(await val(`select operator_set_auto_send(true)`), true); });
    assert.equal(await val(`select operator_setting_on('operator_auto_send')`), true);
    assert.equal(await val(`select count(*)::int from operator_actions where action = 'autosend.on'`), 1);
    await asUser(OTHER, async () => {
      await assert.rejects(db.query(`select operator_set_auto_send(false)`));
      await assert.rejects(db.query(`select operator_set_autonomy('lvlup', 'reply', 'auto')`));
    });
    await db.exec(`set role anon`);
    try { await assert.rejects(db.query(`select operator_set_autonomy('lvlup', 'reply', 'auto')`)); } finally { await db.exec(`reset role`); }
    assert.equal(await val(`select operator_setting_on('operator_auto_send')`), true);
    await asUser(CEO, async () => { await val(`select operator_set_auto_send(false)`); });
  });

  await step('operator dashboard: the drafter follows a client rule (factual = auto for lvlup) once auto-send is on', async () => {
    const ch = await val(`insert into operator_channels (client_slug, kind, name, url) values ('lvlup', 'google_chat', 'Rules room', 'https://chat.google.com/room/AAQA-rules') returning id`);
    await db.query(`insert into settings (key, value) values ('operator_auto_send', 'true'::jsonb) on conflict (key) do update set value = excluded.value`);
    const nid = await val(`select operator_ingest($1, $2::jsonb)`, [ch, JSON.stringify({ external_id: 'r1', sender_name: 'Alex', body: 'What time is the call?', sent_at: '2026-10-17T01:00:00Z' })]);
    assert.equal((await db.query(`select * from operator_claim_new()`)).rows[0].id, nid);
    assert.equal(await val(`select operator_record_draft($1, $2::jsonb)`, [nid, JSON.stringify({ addressed_to_julev: true, category: 'reply', action_types: ['factual'], confidence: 0.9, draft: 'The call is at 3 pm.' })]), 'auto');
    await db.query(`insert into settings (key, value) values ('operator_auto_send', 'false'::jsonb) on conflict (key) do update set value = excluded.value`);
  });
}
