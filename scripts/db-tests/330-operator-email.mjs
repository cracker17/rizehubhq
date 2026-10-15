// Julev Operator phase 3 M8 (supabase/migrations/20261017080000_operator_email.sql): Gmail from non-targets is never
// stored; targeted mail waits as 'held' with a number; the summary goes out once; /open N (or the button) turns it into
// a normal message that is drafted as addressed to Julev; dismiss skips it; 'auto' mode drafts right away.
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
  await db.query(`insert into operator_clients (slug, name, profile) values ('mailco', 'Mail Co', 'mailco') on conflict do nothing`);
  const gmail = await val(`insert into operator_channels (client_slug, kind, name, url, direct) values ('mailco', 'gmail', 'Mail Co inbox', 'https://mail.google.com/mail/u/0/#search/is%3Aunread', true) returning id`);
  let n = 0;
  const mail = (sender_name, sender_email, body, extra = {}) => val(`select operator_ingest($1, $2::jsonb)`,
    [gmail, JSON.stringify({ external_id: `m${++n}`, sender_name, sender_email, body, sent_at: new Date().toISOString(), ...extra })]);

  await step('operator email: only targeted senders are stored; they wait as held with numbers', async () => {
    await asCeo(async () => {
      assert.equal(await val(`select operator_set_email_targets('mailco', array['@lvlup.vc', 'Riley Chen', 'x'])`), 2, 'too-short patterns are dropped');
    });
    const a = await mail('Alex Kim', 'Alex@LvlUp.vc', 'Invoice question - can you resend the September invoice?');
    const b = await mail('Riley Chen', 'riley@gmail.com', 'Logos for the portfolio page');
    const spam = await mail('Newsletter', 'news@shop.example', 'Big sale this week!');
    assert.ok(a && b);
    assert.equal(spam, null, 'non-targets are not stored at all');
    assert.equal(await val(`select count(*)::int from operator_inbox where client_slug = 'mailco' and sender_name = 'Newsletter'`), 0);
    const rows = (await db.query(`select status, pick_no, sender_email from operator_inbox where id = any($1::uuid[]) order by pick_no`, [[a, b]])).rows;
    assert.deepEqual(rows.map((r) => [r.status, r.pick_no]), [['held', 1], ['held', 2]]);
    assert.equal(rows[0].sender_email, 'alex@lvlup.vc');
    assert.equal(await val(`select count(*)::int from operator_inbox where status = 'new' and client_slug = 'mailco'`), 0, 'nothing is drafted yet');
    assert.equal(await mail('Alex Kim', 'alex@lvlup.vc', 'x', { external_id: 'm1' }), null, 'a repeat changes nothing');
  });

  await step('operator email: one summary per batch (after 15 min or 5 mails)', async () => {
    assert.equal(await val(`select operator_email_summary_tick(now())`), 0, 'too early');
    assert.equal(await val(`select operator_email_summary_tick(now() + interval '16 minutes')`), 1);
    assert.equal(await val(`select operator_email_summary_tick(now() + interval '30 minutes')`), 0, 'already summarized');
    const d = await val(`select detail from operator_actions where action = 'email.summary' and client_slug = 'mailco' order by id desc limit 1`);
    assert.deepEqual(d.items.map((i) => [i.n, i.sender]), [[1, 'Alex Kim'], [2, 'Riley Chen']]);
    assert.match(d.items[0].subject, /^Invoice question/);
  });

  await step('operator email: /open 2 makes it a message drafted as addressed; dismiss skips; ambiguous numbers ask', async () => {
    let opened;
    await asCeo(async () => {
      opened = await val(`select operator_open_pick(null, 2)`);
      assert.equal((await val(`select operator_open_pick(null, 7)`)).result, 'not_found');
    });
    assert.deepEqual([opened.result, opened.client, opened.sender], ['opened', 'mailco', 'Riley Chen']);
    const r = (await db.query(`select id, status, opened_at from operator_inbox where client_slug = 'mailco' and pick_no = 2`)).rows[0];
    assert.equal(r.status, 'new');
    assert.ok(r.opened_at);
    for (let c = (await db.query(`select * from operator_claim_new()`)).rows[0]; c?.id; c = (await db.query(`select * from operator_claim_new()`)).rows[0]) {
      if (c.id === r.id) break;
      await val(`select operator_classify_failed($1, 'test skip')`, [c.id]);
    }
    await db.query(`update operator_channels set direct = false where id = $1`, [gmail]);
    assert.equal(await val(`select operator_record_draft($1, $2::jsonb)`, [r.id, JSON.stringify({ category: 'reply', action_types: ['reply'], confidence: 0.9, draft: 'Hi Riley, thanks for the logos!' })]),
      'approval', 'an email Julev opened is meant for him, even without a mention');
    const one = await val(`select id from operator_inbox where client_slug = 'mailco' and pick_no = 1`);
    await asCeo(async () => {
      assert.equal(await val(`select operator_dismiss_email($1)`, [one]), 'dismissed');
      assert.equal(await val(`select operator_open_email($1)`, [one]), 'already_skipped');
    });
    await db.query(`insert into operator_clients (slug, name, profile) values ('mailco2', 'Mail Two', 'mailco2') on conflict do nothing`);
    const g2 = await val(`insert into operator_channels (client_slug, kind, name, url) values ('mailco2', 'gmail', 'Two', 'https://mail.google.com/mail/u/1/#inbox') returning id`);
    await val(`select operator_ingest($1, $2::jsonb)`, [g2, JSON.stringify({ external_id: 'z1', sender_name: 'Zed', body: 'Hello', sent_at: new Date().toISOString() })]);
    await mail('Alex Kim', 'alex@lvlup.vc', 'Second question');
    const n3 = await val(`select pick_no from operator_inbox where client_slug = 'mailco' and body = 'Second question'`);
    await db.query(`update operator_inbox set pick_no = $1 where client_slug = 'mailco2'`, [n3]);
    await asCeo(async () => {
      const amb = await val(`select operator_open_pick(null, $1)`, [n3]);
      assert.equal(amb.result, 'ambiguous');
      assert.equal((await val(`select operator_open_pick('mailco2', $1)`, [n3])).client, 'mailco2');
    });
  });

  await step("operator email: 'auto' drafts right away; only the CEO sets targets and mode", async () => {
    await asCeo(async () => { assert.equal(await val(`select operator_set_email_mode('mailco', 'auto')`), 'auto'); });
    const id = await mail('Alex Kim', 'alex@lvlup.vc', 'Third question');
    assert.equal(await val(`select status from operator_inbox where id = $1`, [id]), 'new');
    await db.exec(`set role anon`);
    try { await assert.rejects(db.query(`select operator_set_email_targets('mailco', array['@x.com'])`)); } finally { await db.exec(`reset role`); }
    await asCeo(async () => {
      await assert.rejects(db.query(`select operator_set_email_mode('mailco', 'sometimes')`), /pick or auto/);
      await assert.rejects(db.query(`select operator_email_summary_tick(now())`));
    });
  });
}
