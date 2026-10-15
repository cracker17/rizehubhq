// Julev Operator phase 3 M8b (supabase/migrations/20261017090000_operator_chat_people.sql): with people to watch set,
// chat messages from others are stored but never drafted; names match part of the display name, numbers match
// WhatsApp senders; empty list = everyone; the CEO sets the list.
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
  await db.query(`insert into operator_clients (slug, name, profile) values ('peopleco', 'People Co', 'peopleco') on conflict do nothing`);
  const ch = await val(`insert into operator_channels (client_slug, kind, name, url, direct) values ('peopleco', 'slack', 'DMs', 'https://app.slack.com/client/T7/D7', true) returning id`);
  let n = 0;
  const draft = async (sender) => {
    const id = await val(`select operator_ingest($1, $2::jsonb)`, [ch, JSON.stringify({ external_id: `p${++n}`, sender_name: sender, body: 'Can you check this?', sent_at: new Date().toISOString() })]);
    for (let c = (await db.query(`select * from operator_claim_new()`)).rows[0]; c?.id; c = (await db.query(`select * from operator_claim_new()`)).rows[0]) {
      if (c.id === id) break;
      await val(`select operator_classify_failed($1, 'test skip')`, [c.id]);
    }
    return val(`select operator_record_draft($1, $2::jsonb)`, [id, JSON.stringify({ category: 'reply', action_types: ['reply'], confidence: 0.9, draft: 'Sure!' })]);
  };

  await step('operator people: empty list = everyone; with a list only those people get drafts, others stay FYI (stored)', async () => {
    assert.equal(await draft('Sam Lee'), 'approval');
    await asCeo(async () => { assert.equal(await val(`select operator_set_chat_people('peopleco', array['Riley', ' Alex Kim ', 'x', '+63 917 111 2222'])`), 3); });
    assert.equal(await draft('Riley Chen'), 'approval', 'part of the display name');
    assert.equal(await draft('alex kim'), 'approval');
    assert.equal(await draft('Sam Lee'), 'fyi');
    const row = (await db.query(`select status, analysis from operator_inbox where client_slug = 'peopleco' and sender_name = 'Sam Lee' order by created_at desc limit 1`)).rows[0];
    assert.deepEqual([row.status, row.analysis.not_watched_person], ['fyi', true]);
    assert.equal(await val(`select operator_chat_person_match('peopleco', '+63 917 111 2222')`), true, 'a WhatsApp number');
    assert.equal(await val(`select operator_chat_person_match('peopleco', '639171112222')`), true);
    await db.exec(`set role anon`);
    try { await assert.rejects(db.query(`select operator_set_chat_people('peopleco', array['x y'])`)); } finally { await db.exec(`reset role`); }
  });
}
