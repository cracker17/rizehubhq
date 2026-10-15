// Julev Operator phase 3 M4 (supabase/migrations/20261017020000_operator_watchers.sql): Gmail / Slack / Teams channels
// are watched like Google Chat; approved or auto-cleared replies there are never claimed for the browser sender: they
// become 'manual' with a reply.manual notice (exact text + link). Job client updates the same. Google Chat still sends.
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
  const claimSend = () => db.query(`select * from operator_claim_send()`).then((r) => (r.rows[0]?.id ? r.rows[0] : null));
  let slack; let gchat;

  await step('operator watchers: the CEO adds Gmail / Slack / Teams channels; addresses are checked per kind', async () => {
    await asCeo(async () => {
      slack = await val(`select operator_add_watch('lvlup', 'slack', '#general', 'https://app.slack.com/client/T01/C02')`);
      await val(`select operator_add_watch('lvlup', 'gmail', 'LvlUp mail', 'https://mail.google.com/mail/u/0/#label/LvlUp')`);
      await val(`select operator_add_watch('lvlup', 'teams', 'Teams chat', 'https://teams.microsoft.com/l/chat/19:abc/0')`);
      await assert.rejects(db.query(`select operator_add_watch('lvlup', 'slack', 'x', 'https://chat.google.com/room/A')`), /Slack channel address/);
      await assert.rejects(db.query(`select operator_add_watch('lvlup', 'gmail', 'x', 'https://evil.example/mail/')`), /Gmail address/);
      await assert.rejects(db.query(`select operator_add_watch('lvlup', 'fax', 'x', 'https://x')`), /unknown channel kind/);
    });
    assert.equal(await val(`select kind from operator_channels where id = $1`, [slack]), 'slack');
    await assert.rejects(db.query(`insert into operator_channels (client_slug, kind, name, url) values ('lvlup', 'teams', 'bad', 'https://chat.google.com/room/Z')`));
    gchat = await val(`insert into operator_channels (client_slug, kind, name, url) values ('lvlup', 'google_chat', 'Watchers room', 'https://chat.google.com/room/AAQA-watch') returning id`);
  });

  const draft = async (ch, id, body, result) => {
    const nid = await val(`select operator_ingest($1, $2::jsonb)`, [ch, JSON.stringify({ external_id: id, sender_name: 'Alex', body, sent_at: '2026-10-17T02:00:00Z' })]);
    assert.equal((await db.query(`select * from operator_claim_new()`)).rows[0].id, nid);
    return { nid, outcome: await val(`select operator_record_draft($1, $2::jsonb)`, [nid, JSON.stringify(result)]) };
  };

  await step('operator watchers: an approved Slack reply becomes manual (never claimed); Google Chat is still sent', async () => {
    const s = await draft(slack, 's1', 'Can you check the pricing page?', { category: 'reply', action_types: ['reply'], confidence: 0.9, draft: 'Checking it now, Alex.' });
    const g = await draft(gchat, 'g1', 'Thanks!', { category: 'reply', action_types: ['reply'], confidence: 0.9, draft: 'Anytime!' });
    assert.deepEqual([s.outcome, g.outcome], ['approval', 'approval']);
    await val(`select decide_approval($1, 'changes', 'Checking it now, @Alex. Back in 10.', 'telegram')`, [await val(`select approval_id from operator_inbox where id = $1`, [s.nid])]);
    await val(`select decide_approval($1, 'approve', null, 'telegram')`, [await val(`select approval_id from operator_inbox where id = $1`, [g.nid])]);
    const claimed = [];
    for (let c = await claimSend(); c; c = await claimSend()) claimed.push(c.id); // earlier suites may leave approved rows
    assert.ok(claimed.includes(g.nid), 'the Google Chat reply is claimed for the browser');
    assert.ok(!claimed.includes(s.nid), 'the Slack reply never is');
    const row = (await db.query(`select status, final_text from operator_inbox where id = $1`, [s.nid])).rows[0];
    assert.deepEqual([row.status, row.final_text], ['manual', 'Checking it now, @Alex. Back in 10.']);
    const n = (await db.query(`select detail from operator_actions where action = 'reply.manual' and inbox_id = $1`, [s.nid])).rows[0].detail;
    assert.deepEqual([n.kind, n.channel, n.text], ['slack', '#general', 'Checking it now, @Alex. Back in 10.']);
    assert.equal(n.url, 'https://app.slack.com/client/T01/C02');
  });

  await step('operator watchers: an auto-cleared reply on a read-only channel is handed over too', async () => {
    await db.query(`insert into settings (key, value) values ('operator_auto_send', 'true'::jsonb) on conflict (key) do update set value = excluded.value`);
    const s = await draft(slack, 's2', 'Thanks for the update!', { category: 'reply', action_types: ['thanks'], confidence: 0.95, draft: 'You\'re welcome!' });
    assert.equal(s.outcome, 'auto');
    assert.equal(await claimSend(), null);
    assert.equal(await val(`select status from operator_inbox where id = $1`, [s.nid]), 'manual');
    await db.query(`update settings set value = 'false'::jsonb where key = 'operator_auto_send'`);
  });

  await step('operator watchers: a job update for a Slack thread becomes manual (update.manual), never sent by the browser', async () => {
    const jid = await val(`insert into operator_jobs (client_slug, source, title, brief, channel_id, status) values ('lvlup', 'ceo', 'Pricing check', 'Check pricing', $1, 'done') returning id`, [slack]);
    const oid = await val(`insert into operator_outbox (client_slug, channel_id, job_id, text, mode, status, final_text) values ('lvlup', $1, $2, 'All good, Alex: pricing page checked.', 'approve', 'approved', 'All good, Alex: pricing page checked.') returning id`, [slack, jid]);
    assert.equal((await db.query(`select * from operator_claim_update()`)).rows[0]?.id ?? null, null);
    assert.equal(await val(`select status from operator_outbox where id = $1`, [oid]), 'manual');
    assert.equal(await val(`select detail ->> 'text' from operator_actions where action = 'update.manual' and job_id = $1`, [jid]), 'All good, Alex: pricing page checked.');
  });
}
