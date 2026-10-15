// Julev Operator (supabase/migrations/20261015000000_operator.sql): ingest is idempotent and baseline / own messages are
// never answered; drafts follow the autonomy tiers (auto only with operator_auto_send on and confidence >= 0.75, 'never'
// blocks, everything else is an approval Telegram can decide); Send / Edit / Skip flow to the inbox row; the kill switch,
// the office pause and a client pause all stop operator_claim_send; only the service role can drive the state machine.
export default async function ({ db, step, val, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  let channel;
  const ingest = (id, extra = {}) => val(`select operator_ingest($1, $2::jsonb)`, [channel, JSON.stringify({
    external_id: id, sender_name: 'Alex', body: `message ${id}`, sent_at: '2026-10-15T01:00:00Z', ...extra })]);
  const claim = () => db.query(`select * from operator_claim_new()`).then((r) => (r.rows[0]?.id ? r.rows[0] : undefined)); // a null composite = all-null row
  const draft = (id, result) => val(`select operator_record_draft($1, $2::jsonb)`, [id, JSON.stringify(result)]);
  const row = (id) => db.query(`select * from operator_inbox where id = $1`, [id]).then((r) => r.rows[0]);
  const setting = (k, v) => db.query(`insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [k, JSON.stringify(v)]);
  const claimSend = () => db.query(`select * from operator_claim_send()`).then((r) => r.rows[0]?.id ?? null);
  // The CEO has a TOTP factor by now (earlier suites): is_ceo() needs an aal2 session.
  async function asCeo(fn) {
    await db.exec(`set role authenticated`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [CEO, JSON.stringify({ role: 'authenticated', sub: CEO, aal: 'aal2', amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  async function newDrafted(id, result) {
    const nid = await ingest(id);
    const c = await claim();
    assert.equal(c.id, nid);
    return { id: nid, outcome: await draft(nid, result) };
  }

  await step('operator: LvlUp is seeded with rules; default tiers auto only ack/status/thanks', async () => {
    assert.equal(await val(`select profile from operator_clients where slug = 'lvlup'`), 'lvlup');
    assert.match(await val(`select rules from operator_clients where slug = 'lvlup'`), /financial/);
    assert.deepEqual((await db.query(`select action_type from operator_autonomy where client_slug = '*' and mode = 'auto' order by 1`)).rows.map((r) => r.action_type),
      ['ack', 'status', 'thanks']);
    assert.equal(await val(`select operator_mode_for('lvlup', 'credentials')`), 'never');
    channel = await val(`insert into operator_channels (client_slug, kind, name, url) values ('lvlup', 'google_chat', 'Alex, Riley', 'https://chat.google.com/room/AAQA-test') returning id`);
  });

  await step('operator: ingest is idempotent; baseline and own messages are history (fyi), never answered', async () => {
    const a = await ingest('m1');
    assert.ok(a);
    assert.equal(await ingest('m1'), null, 'same external id twice → nothing new');
    const b = await ingest('m0', { baseline: true });
    const c = await ingest('m-me', { from_me: true, sender_name: 'Julev' });
    assert.equal((await row(b)).status, 'fyi');
    assert.equal((await row(c)).status, 'fyi');
    assert.equal(await val(`select count(*)::int from operator_actions where action = 'message.new'`), 3);
    // m1 is classified as FYI: nothing to send
    const claimed = await claim();
    assert.equal(claimed.id, a);
    assert.equal(await draft(a, { category: 'fyi', confidence: 0.9, summary: 'just info' }), 'fyi');
    assert.equal((await row(a)).status, 'fyi');
    assert.equal(await claim(), undefined, 'nothing else is new');
  });

  await step('operator: an ack waits for approval while auto-send is off (phase 1 default)', async () => {
    const { id, outcome } = await newDrafted('m2', { category: 'reply', action_types: ['ack'], confidence: 0.95, draft: 'On it!' });
    assert.equal(outcome, 'approval');
    const r = await row(id);
    assert.equal(r.status, 'drafted');
    assert.equal(r.mode, 'approve');
    const ap = (await db.query(`select * from approvals where id = $1`, [r.approval_id])).rows[0];
    assert.equal(ap.kind, 'external_action');
    assert.equal(ap.payload.type, 'operator_reply');
    assert.equal(await val(`select approval_is_high_risk(a) from approvals a where id = $1`, [ap.id]), false, 'Telegram can approve it');
    // ✅ Send → approved with the draft
    assert.equal(await val(`select decide_approval($1, 'approve', null, 'telegram')`, [ap.id]), 'action_approved');
    const after = await row(id);
    assert.equal(after.status, 'approved');
    assert.equal(after.final_text, 'On it!');
  });

  await step('operator: with auto-send on, a confident ack/thanks goes straight to approved; low confidence still asks', async () => {
    await setting('operator_auto_send', true);
    const hi = await newDrafted('m3', { category: 'reply', action_types: ['thanks'], confidence: 0.9, draft: 'Thanks Alex!' });
    assert.equal(hi.outcome, 'auto');
    assert.equal((await row(hi.id)).final_text, 'Thanks Alex!');
    const lo = await newDrafted('m4', { category: 'reply', action_types: ['ack'], confidence: 0.5, draft: 'Got it' });
    assert.equal(lo.outcome, 'approval');
    // the strictest type wins: ack + deadline → approval
    const mixed = await newDrafted('m5', { category: 'reply', action_types: ['ack', 'deadline'], confidence: 0.95, draft: 'Done by Friday' });
    assert.equal(mixed.outcome, 'approval');
    // a 'never' type blocks it outright
    const never = await newDrafted('m6', { category: 'reply', action_types: ['ack', 'credentials'], confidence: 0.99, draft: 'The password is …' });
    assert.equal(never.outcome, 'blocked');
    assert.equal((await row(never.id)).status, 'blocked');
    assert.equal(await val(`select count(*)::int from approvals where payload ->> 'inbox_id' = $1`, [never.id]), 0);
    // tasks always ask (even when only 'ack' was given)
    const task = await newDrafted('m7', { category: 'task', action_types: ['ack'], confidence: 0.99, draft: 'On it, will update you here.' });
    assert.equal(task.outcome, 'approval');
    await setting('operator_auto_send', false);
  });

  await step('operator: ✏️ Edit sends the CEO text; ❌ Skip skips; a decided row is not reopened', async () => {
    const edit = await newDrafted('m8', { category: 'reply', action_types: ['reply'], confidence: 0.8, draft: 'draft text' });
    const ap = await val(`select approval_id from operator_inbox where id = $1`, [edit.id]);
    await val(`select decide_approval($1, 'changes', 'Edited by Julev', 'telegram')`, [ap]);
    assert.equal((await row(edit.id)).status, 'approved');
    assert.equal((await row(edit.id)).final_text, 'Edited by Julev');
    const skip = await newDrafted('m9', { category: 'reply', action_types: ['reply'], confidence: 0.8, draft: 'nope' });
    await val(`select decide_approval($1, 'reject', null, 'telegram')`, [await val(`select approval_id from operator_inbox where id = $1`, [skip.id])]);
    assert.equal((await row(skip.id)).status, 'skipped');
    assert.ok(await val(`select count(*)::int from operator_actions where action in ('reply.approved', 'reply.edited', 'reply.skipped')`) >= 3);
  });

  await step('operator: the kill switch, the office pause and a client pause stop every send', async () => {
    const approved = await val(`select count(*)::int from operator_inbox where status = 'approved'`);
    assert.ok(approved >= 2);
    await val(`select operator_set_paused(true, 'telegram')`);
    assert.equal(await claimSend(), null, 'kill switch');
    assert.equal(await val(`select operator_send_blocker('lvlup')`), 'operator paused (kill switch)');
    await val(`select operator_set_paused(false, 'telegram')`);
    await setting('paused', true);
    assert.equal(await claimSend(), null, 'office pause');
    await setting('paused', false);
    await val(`select operator_set_client_paused('lvlup', true, 'telegram')`);
    assert.equal(await claimSend(), null, 'client pause');
    await val(`select operator_set_client_paused('lvlup', false, 'telegram')`);
    const id = await claimSend();
    assert.ok(id, 'sends again once every pause is off');
    assert.equal((await row(id)).status, 'sending');
    assert.equal(await val(`select operator_may_send($1)`, [id]), null);
    // a /pause landing mid-send: the last check refuses
    await val(`select operator_set_paused(true, 'telegram')`);
    assert.equal(await val(`select operator_may_send($1)`, [id]), 'operator paused (kill switch)');
    await val(`select operator_set_paused(false, 'telegram')`);
    assert.equal(await val(`select operator_send_done($1, true, null, '{}'::jsonb)`, [id]), 'sent');
    assert.equal(await val(`select count(*)::int from operator_actions where action = 'operator.paused'`), 2);
  });

  await step('operator: failed sends retry, then fail after 3 attempts; poll errors are logged once', async () => {
    const id = await claimSend();
    assert.ok(id);
    assert.equal(await val(`select operator_send_done($1, false, 'composer not found')`, [id]), 'approved');
    await claimSend(); await val(`select operator_send_done($1, false, 'composer not found')`, [id]);
    // the other approved row may be claimed first: drain until this one fails
    for (let i = 0; i < 4 && (await row(id)).status !== 'failed'; i++) {
      const c = await claimSend();
      if (c) await val(`select operator_send_done($1, false, 'composer not found')`, [c]);
    }
    assert.equal((await row(id)).status, 'failed');
    await val(`select operator_channel_polled($1, 'k1', 'signed out')`, [channel]);
    await val(`select operator_channel_polled($1, 'k2', 'signed out')`, [channel]);
    assert.equal(await val(`select count(*)::int from operator_actions where action = 'watch.failed'`), 1);
    await val(`select operator_channel_polled($1, 'k3', null)`, [channel]);
    assert.equal(await val(`select last_seen_key from operator_channels where id = $1`, [channel]), 'k3');
    assert.equal(await val(`select count(*)::int from operator_actions where action = 'watch.recovered'`), 1);
  });

  await step('operator: the CEO reads and pauses; nobody else can; only the service role drives the state machine', async () => {
    await asCeo(async () => {
      assert.ok(await val(`select count(*)::int from operator_inbox`) > 0);
      assert.equal(await val(`select operator_set_paused(true, 'dashboard')`), true);
      assert.equal(await val(`select operator_set_paused(false, 'dashboard')`), false);
      assert.equal((await val(`select operator_client_status('lvlup')`)).client.slug, 'lvlup');
      const added = await val(`select operator_add_channel('lvlup', 'Sam, Jordan', 'https://chat.google.com/room/AAQB-x')`);
      assert.ok(added);
      await assert.rejects(db.query(`select operator_add_channel('lvlup', 'Evil', 'https://evil.example/chat')`), /chat\.google\.com/);
      assert.equal(await val(`select operator_set_channel_enabled($1, false)`, [added]), false);
      await val(`select operator_set_viewer_url('lvlup', 'https://ws.rizehub.ph/lvlup/')`);
      await assert.rejects(db.query(`select operator_set_viewer_url('lvlup', 'http://plain')`), /https/);
      await assert.rejects(db.query(`select operator_claim_send()`), /permission denied/);
      await assert.rejects(db.query(`insert into operator_inbox (client_slug, channel_id, external_id, body) values ('lvlup', $1, 'x', 'x')`, [channel]), /permission denied/);
    });
    await as('authenticated', OTHER, async () => {
      assert.equal(await val(`select count(*)::int from operator_inbox`), 0);
      await assert.rejects(db.query(`select operator_set_paused(true)`), /not allowed/);
    });
    await as('anon', null, async () => {
      await assert.rejects(db.query(`select operator_set_paused(true)`), /permission denied/);
      await assert.rejects(db.query(`select operator_ingest($1, '{}'::jsonb)`, [channel]), /permission denied/);
    });
  });
}
