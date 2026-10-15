// Julev Operator phase 3 M6a (supabase/migrations/20261017040000_operator_discovery.sql): replies are drafted only for
// messages addressed to Julev (DM / WhatsApp / @mention / the classifier says so) unless the client is set to 'all';
// the CEO adds app accounts; the sweep's discoveries create auto channels once (a stopped one stays stopped); sweep
// errors notify once.
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
  await db.query(`insert into operator_clients (slug, name, profile) values ('discoco', 'Disco Co', 'discoco') on conflict do nothing`);
  let n = 0;
  const msg = async (ch, extra = {}) => {
    const nid = await val(`select operator_ingest($1, $2::jsonb)`, [ch, JSON.stringify({ external_id: `d${++n}`, sender_name: 'Riley', body: 'Can someone check the footer?', sent_at: new Date().toISOString(), ...extra })]);
    for (let c = (await db.query(`select * from operator_claim_new()`)).rows[0]; c?.id; c = (await db.query(`select * from operator_claim_new()`)).rows[0]) {
      if (c.id === nid) return nid;
      await val(`select operator_classify_failed($1, 'test skip')`, [c.id]); // other suites' leftovers
    }
    return nid;
  };
  const draft = (nid, extra = {}) => val(`select operator_record_draft($1, $2::jsonb)`, [nid, JSON.stringify({ category: 'reply', action_types: ['reply'], confidence: 0.9, draft: 'I will check it.', ...extra })]);
  let group; let dm;

  await step('operator discovery: group chatter not addressed to Julev stays FYI; DMs, @mentions and questions to him get drafts', async () => {
    group = await val(`insert into operator_channels (client_slug, kind, name, url) values ('discoco', 'slack', '#team', 'https://app.slack.com/client/T9/C1') returning id`);
    dm = await val(`insert into operator_channels (client_slug, kind, name, url, direct) values ('discoco', 'slack', 'Riley', 'https://app.slack.com/client/T9/D1', true) returning id`);
    const a = await msg(group);
    assert.equal(await draft(a), 'fyi', 'nobody asked Julev');
    const row = (await db.query(`select status, analysis from operator_inbox where id = $1`, [a])).rows[0];
    assert.deepEqual([row.status, row.analysis.not_addressed, row.analysis.drafted_category], ['fyi', true, 'reply']);
    assert.equal(await draft(await msg(group), { addressed_to_julev: true }), 'approval', 'a question to Julev in the thread');
    assert.equal(await draft(await msg(group, { mentions_me: true })), 'approval', '@Julev');
    assert.equal(await draft(await msg(dm)), 'approval', 'a direct message');
    await asCeo(async () => { assert.equal(await val(`select operator_set_reply_when('discoco', 'all')`), 'all'); });
    assert.equal(await draft(await msg(group)), 'approval', "'all' drafts for anything that needs a reply");
    await asCeo(async () => {
      await val(`select operator_set_reply_when('discoco', 'addressed')`);
      await assert.rejects(db.query(`select operator_set_reply_when('discoco', 'sometimes')`), /addressed or all/);
    });
  });

  await step('operator discovery: accounts by the CEO; the sweep finds a conversation once; a stopped one stays stopped', async () => {
    let acc;
    await asCeo(async () => {
      acc = await val(`select operator_add_account('discoco', 'slack', 'Disco Slack', 'https://app.slack.com/client/T9')`);
      await assert.rejects(db.query(`select operator_add_account('discoco', 'slack', 'x', 'https://chat.google.com/')`), /not a slack address/);
      await assert.rejects(db.query(`select operator_discover($1, 'x', 'https://app.slack.com/client/T9/C9', false)`, [acc]));
    });
    const first = await val(`select operator_discover($1, 'Sam', 'https://app.slack.com/client/T9/D7', true)`, [acc]);
    assert.deepEqual([first.created, first.enabled], [true, true]);
    const again = await val(`select operator_discover($1, 'Sam', 'https://app.slack.com/client/T9/D7', true)`, [acc]);
    assert.deepEqual([again.created, again.channel_id], [false, first.channel_id]);
    const ch = (await db.query(`select kind, direct, auto_discovered, account_id from operator_channels where id = $1`, [first.channel_id])).rows[0];
    assert.deepEqual([ch.kind, ch.direct, ch.auto_discovered, ch.account_id], ['slack', true, true, acc]);
    await asCeo(async () => { await val(`select operator_set_channel_enabled($1, false)`, [first.channel_id]); });
    assert.equal((await val(`select operator_discover($1, 'Sam', 'https://app.slack.com/client/T9/D7', true)`, [acc])).enabled, false);
    await assert.rejects(db.query(`select operator_discover($1, 'x', 'https://evil.example/', false)`, [acc]), /not a slack address/);
    assert.equal(await val(`select count(*)::int from operator_actions where action = 'channel.discovered' and client_slug = 'discoco'`), 1);

    await val(`select operator_account_swept($1, 3, 'signed out of Slack')`, [acc]);
    await val(`select operator_account_swept($1, 0, 'signed out of Slack')`, [acc]);
    await val(`select operator_account_swept($1, 2, null)`, [acc]);
    assert.equal(await val(`select count(*)::int from operator_actions where action = 'watch.failed' and client_slug = 'discoco'`), 1);
    assert.equal(await val(`select count(*)::int from operator_actions where action = 'watch.recovered' and client_slug = 'discoco'`), 1);
    assert.equal(await val(`select last_found from operator_accounts where id = $1`, [acc]), 2);
    await asCeo(async () => { assert.equal(await val(`select operator_set_account_enabled($1, false)`, [acc]), false); });
  });
}
