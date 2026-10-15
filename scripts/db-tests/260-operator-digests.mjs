// Julev Operator phase 3 M2 (supabase/migrations/20261017010000_operator_digests.sql): the morning / evening digests are
// saved once per local day after their time (not more than 3 h late), with the right window and per-client facts;
// times are the CEO's to change (off works); the tick and the facts are service-only.
export default async function ({ db, step, val, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  async function asUser(id, fn) {
    await db.exec(`set role authenticated`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [id, JSON.stringify({ role: 'authenticated', sub: id, aal: 'aal2', amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  const tick = (iso) => db.query(`select operator_digest_tick($1::timestamptz) as k`, [iso]).then((r) => r.rows[0].k);
  // Manila = UTC+8: 08:00 local on 2026-10-20 is 00:00Z, 18:00 local is 10:00Z.
  await db.query(`delete from reports where kind like 'operator_%'`);
  await db.query(`insert into settings (key, value) values ('timezone', '"Asia/Manila"'::jsonb) on conflict (key) do update set value = excluded.value`);

  await step('operator digests: morning at 08:00 Manila, once; evening at 18:00; nothing before the time or 3 h after', async () => {
    assert.deepEqual(await tick('2026-10-19T23:59:00Z'), [], '07:59 local: not yet');
    assert.deepEqual(await tick('2026-10-20T00:00:30Z'), ['operator_morning']);
    assert.deepEqual(await tick('2026-10-20T00:05:00Z'), [], 'once per day');
    assert.deepEqual(await tick('2026-10-20T10:00:00Z'), ['operator_evening']);
    assert.deepEqual(await tick('2026-10-21T03:30:00Z'), [], '11:30 local next day: the morning digest is too late, skipped');
    const r = (await db.query(`select report_date::text d, data from reports where kind = 'operator_evening'`)).rows[0];
    assert.equal(r.d, '2026-10-20');
    assert.equal(new Date(r.data.from).toISOString(), '2026-10-20T00:00:00.000Z', 'evening window starts at this morning\'s digest time');
    const m = (await db.query(`select data from reports where kind = 'operator_morning'`)).rows[0];
    assert.equal(new Date(m.data.from).toISOString(), '2026-10-19T10:00:00.000Z', 'morning window starts at yesterday\'s evening time');
    assert.equal(await val(`select count(*)::int from operator_actions where action = 'digest.saved'`), 2);
  });

  await step('operator digests: per-client facts (messages, replies, waiting, jobs done / open / stuck, logins, failures, spend)', async () => {
    await db.query(`insert into operator_clients (slug, name, profile) values ('digestco', 'Digest Co', 'digestco')`);
    await db.query(`insert into operator_logins (client_slug, site, label, check_url) values ('digestco', 'webflow', 'Webflow', 'https://webflow.com/dashboard')`);
    const ch = await val(`insert into operator_channels (client_slug, kind, name, url) values ('digestco', 'google_chat', 'Digest room', 'https://chat.google.com/room/AAQA-digest') returning id`);
    const t = new Date(Date.now() - 60_000).toISOString();
    await db.query(`insert into operator_inbox (client_slug, channel_id, external_id, sender_name, body, status, category, created_at)
                    values ('digestco', $1, 'd1', 'Alex', 'hi', 'sent', 'reply', $2), ('digestco', $1, 'd2', 'Alex', 'old history', 'fyi', null, $2),
                           ('digestco', $1, 'd3', 'Julev', 'mine', 'fyi', null, $2)`, [ch, t]);
    await db.query(`update operator_inbox set from_me = true where external_id = 'd3'`);
    await db.query(`insert into operator_actions (actor, action, client_slug, ok, detail, created_at) values
                    ('operator', 'send.done', 'digestco', true, '{"mode":"auto"}', $1), ('operator', 'send.done', 'digestco', true, '{"mode":"approve"}', $1),
                    ('operator', 'update.done', 'digestco', true, '{}', $1), ('operator', 'watch.failed', 'digestco', false, '{}', $1)`, [t]);
    await db.query(`insert into operator_jobs (client_slug, source, title, brief, status, result, finished_at, cost_usd) values
                    ('digestco', 'ceo', 'Fix footer', 'Fix the footer', 'done', '{"links":["https://www.lvlup.vc"]}', $1, 0.5),
                    ('digestco', 'ceo', 'New logos', 'New logos', 'escalated', '{"needs_from_julev":"Send the logos"}', null, 0.2),
                    ('digestco', 'ceo', 'Team page', 'Team page', 'waiting', '{}', null, 0)`, [t]);
    await db.query(`update operator_logins set state = 'signed_out' where client_slug = 'digestco' and site = 'webflow'`);
    await db.query(`insert into activity_log (actor, action, cost_usd, created_at) values ('operator', 'usage.operator', 0.42, $1)`, [t]);
    await db.query(`insert into approvals (kind, title, summary, payload) values ('external_action', 'Reply', 'x', '{"type":"operator_reply","client":"digestco"}')`);
    const f = await val(`select operator_digest_facts('operator_evening', now() - interval '1 hour', now() + interval '1 minute')`);
    const c = f.clients.find((x) => x.slug === 'digestco');
    assert.equal(c.messages, 1, 'baseline history and own messages do not count');
    assert.deepEqual([c.replies_sent, c.auto_sent, c.updates_sent, c.failures], [2, 1, 1, 1]);
    assert.ok(c.waiting >= 1);
    assert.deepEqual(c.jobs_done.map((j) => j.title), ['Fix footer']);
    assert.ok(c.jobs_open.some((j) => j.title === 'Team page' && j.status === 'waiting'));
    assert.deepEqual(c.jobs_stuck.map((j) => [j.title, j.why]).filter(([x]) => x === 'New logos'), [['New logos', 'Send the logos']]);
    assert.deepEqual(c.logins_bad, ['Webflow']);
    assert.ok(Number(f.spend_usd) >= 0.42);
  });

  await step('operator digests: the CEO sets the times (off = no digest); tick and facts are service-only', async () => {
    await asUser(CEO, async () => {
      await val(`select operator_set_digest_times('07:30', null)`);
      await assert.rejects(db.query(`select operator_set_digest_times('7:30', '18:00')`), /HH:MM/);
      await assert.rejects(db.query(`select operator_digest_tick(now())`));
      await assert.rejects(db.query(`select operator_digest_facts('operator_morning', now(), now())`));
    });
    assert.deepEqual(await tick('2026-10-23T10:30:00Z'), [], 'evening is off');
    assert.deepEqual(await tick('2026-10-22T23:31:00Z'), ['operator_morning'], '07:31 local on the 23rd');
    await db.query(`update settings set value = '{"morning":"08:00","evening":"18:00"}'::jsonb where key = 'operator_digest_times'`);
  });
}
