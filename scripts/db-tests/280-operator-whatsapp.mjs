// Julev Operator phase 3 M5 (supabase/migrations/20261017030000_operator_whatsapp.sql): the CEO connects a WhatsApp
// Business number; webhook messages land on its channel (repeats ignored, unknown numbers dropped), are drafted like any
// message, and approved replies ARE claimed for sending (unlike Slack / Teams / Gmail); the 24 h window is readable.
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
  const ingest = (pid, m) => val(`select operator_whatsapp_ingest($1, $2::jsonb)`, [pid, JSON.stringify(m)]);
  let ch;

  await step('operator whatsapp: the CEO connects a business number (number and Meta id checked, one client per number)', async () => {
    await asCeo(async () => {
      ch = await val(`select operator_add_whatsapp('lvlup', 'LvlUp WhatsApp', '+63 917 555 0101', '109876543210987')`);
      await assert.rejects(db.query(`select operator_add_whatsapp('lvlup', 'x', '12', '109876543210987')`), /full international number/);
      await assert.rejects(db.query(`select operator_add_whatsapp('lvlup', 'x', '+63 917 555 0102', 'abc')`), /phone number ID/);
    });
    const r = (await db.query(`select kind, url, wa_phone_id from operator_channels where id = $1`, [ch])).rows[0];
    assert.deepEqual([r.kind, r.url, r.wa_phone_id], ['whatsapp', 'https://wa.me/639175550101', '109876543210987']);
    await db.query(`insert into operator_clients (slug, name, profile) values ('waother', 'Other', 'waother') on conflict do nothing`);
    await asCeo(async () => {
      await assert.rejects(db.query(`select operator_add_whatsapp('waother', 'x', '+63 917 555 0101', '109876543210987')`), /another client/);
    });
  });

  await step('operator whatsapp: webhook messages are stored once, on the right channel, never as baseline; unknown numbers are dropped', async () => {
    const m = { external_id: 'wamid.HBgM1', thread_key: '639171112222', sender_name: 'Sam Lee', body: 'Hi! Is the event on Friday?', sent_at: new Date(Date.now() - 3600_000).toISOString(), baseline: true };
    const id = await ingest('109876543210987', m);
    assert.ok(id);
    assert.equal(await ingest('109876543210987', m), null, 'Meta retries the same wamid: ignored');
    assert.equal(await ingest('555555555555', m), null, 'a number nobody connected');
    const row = (await db.query(`select status, thread_key, space_name, url from operator_inbox where id = $1`, [id])).rows[0];
    assert.deepEqual([row.status, row.thread_key, row.space_name, row.url], ['new', '639171112222', 'LvlUp WhatsApp', 'https://wa.me/639175550101']);
    await assert.rejects(db.query(`select operator_whatsapp_ingest('109876543210987', '{"body":"x"}'::jsonb)`), /needs its id and sender/);
    const last = await val(`select operator_whatsapp_last_inbound($1, '639171112222')`, [ch]);
    assert.ok(Date.now() - new Date(last).getTime() < 2 * 3600_000);
    await asCeo(async () => { await assert.rejects(db.query(`select operator_whatsapp_ingest('109876543210987', $1::jsonb)`, [JSON.stringify(m)])); });
  });

  await step('operator whatsapp: an approved reply is claimed for sending (WhatsApp is a sending channel)', async () => {
    const claim = await db.query(`select * from operator_claim_new()`);
    const nid = claim.rows[0].id;
    assert.equal(await val(`select operator_record_draft($1, $2::jsonb)`, [nid, JSON.stringify({ category: 'reply', action_types: ['factual'], confidence: 0.9, draft: 'Yes, Friday at 6 pm!' })]), 'approval');
    await val(`select decide_approval($1, 'approve', null, 'telegram')`, [await val(`select approval_id from operator_inbox where id = $1`, [nid])]);
    const claimed = [];
    for (let r = (await db.query(`select * from operator_claim_send()`)).rows[0]; r?.id; r = (await db.query(`select * from operator_claim_send()`)).rows[0]) claimed.push(r.id);
    assert.ok(claimed.includes(nid));
    assert.equal(await val(`select status from operator_inbox where id = $1`, [nid]), 'sending');
  });
}
