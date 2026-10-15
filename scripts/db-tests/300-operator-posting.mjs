// Julev Operator phase 3 M6b (supabase/migrations/20261017050000_operator_posting.sql): Slack / Teams / Gmail replies
// stay manual until that app passed a send test for the client AND the CEO switched posting on; a failed test turns it
// off; the test queue is service-only; Google Chat / WhatsApp are unaffected.
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
  await db.query(`insert into operator_clients (slug, name, profile) values ('postco', 'Post Co', 'postco') on conflict do nothing`);
  const posts = (k) => val(`select operator_channel_posts('postco', $1)`, [k]);

  await step('operator posting: off until a passed send test + the CEO switch; Google Chat / WhatsApp always', async () => {
    assert.deepEqual([await posts('google_chat'), await posts('whatsapp'), await posts('slack')], [true, true, false]);
    await asCeo(async () => {
      await assert.rejects(db.query(`select operator_set_posting('postco', 'slack', true)`), /send test first/);
      await assert.rejects(db.query(`select operator_request_send_test('postco', 'slack', 'https://chat.google.com/room/X')`), /not a slack address/);
      assert.equal(await val(`select operator_request_send_test('postco', 'slack', 'https://app.slack.com/client/T5/D5')`), 'requested');
    });
    const t = (await db.query(`select * from operator_claim_send_test()`)).rows.find((r) => r.client_slug === 'postco');
    assert.equal(t.test_url, 'https://app.slack.com/client/T5/D5');
    assert.equal(await val(`select test_state from operator_posting where client_slug = 'postco' and kind = 'slack'`), 'running');
    assert.equal(await val(`select operator_send_test_done('postco', 'slack', true, 'posted and read back')`), 'passed');
    assert.equal(await posts('slack'), false, 'a passed test alone does not post');
    await asCeo(async () => { assert.equal(await val(`select operator_set_posting('postco', 'slack', true)`), true); });
    assert.equal(await posts('slack'), true);
    assert.equal(await val(`select count(*)::int from operator_actions where action = 'posting.tested' and client_slug = 'postco'`), 1);
  });

  await step('operator posting: a failed test switches posting off; an approved Slack reply is then manual again', async () => {
    await asCeo(async () => { await val(`select operator_request_send_test('postco', 'slack', 'https://app.slack.com/client/T5/D5')`); });
    for (let r = (await db.query(`select * from operator_claim_send_test()`)).rows[0]; r?.client_slug; r = (await db.query(`select * from operator_claim_send_test()`)).rows[0]) {
      if (r.client_slug !== 'postco') await val(`select operator_send_test_done($1, $2, false, 'skip')`, [r.client_slug, r.kind]);
    }
    assert.equal(await val(`select operator_send_test_done('postco', 'slack', false, 'composer not found')`), 'failed');
    assert.deepEqual((await db.query(`select enabled, test_state from operator_posting where client_slug = 'postco' and kind = 'slack'`)).rows[0], { enabled: false, test_state: 'failed' });
    assert.equal(await posts('slack'), false);
    const ch = await val(`insert into operator_channels (client_slug, kind, name, url, direct) values ('postco', 'slack', 'DM', 'https://app.slack.com/client/T5/D6', true) returning id`);
    const nid = await val(`insert into operator_inbox (client_slug, channel_id, external_id, sender_name, body, status, final_text) values ('postco', $1, 'p1', 'Riley', 'hi', 'approved', 'Hi Riley!') returning id`, [ch]);
    for (let c = (await db.query(`select * from operator_claim_send()`)).rows[0]; c?.id; c = (await db.query(`select * from operator_claim_send()`)).rows[0]) assert.notEqual(c.id, nid);
    assert.equal(await val(`select status from operator_inbox where id = $1`, [nid]), 'manual');
    await asCeo(async () => {
      await assert.rejects(db.query(`select * from operator_claim_send_test()`));
      await assert.rejects(db.query(`select operator_send_test_done('postco', 'slack', true, 'x')`));
    });
  });
}
