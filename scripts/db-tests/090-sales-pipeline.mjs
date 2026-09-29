// Sales pipeline (supabase/migrations/20260928090000_sales_pipeline.sql): leads from public sources only, drafts,
// suppression, the daily batch approval + per-email decisions, send claiming under the cap, follow-ups 3/7/14 then
// no-response, inbound replies (threading, unsubscribe), stage rules, won → onboarding, and who may call what.
export default async function ({ db, step, val, one, status, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const lead = (p) => val(`select sales_upsert_lead($1::jsonb, null)->>'id'`, [JSON.stringify(p)]);
  const draft = (id, kind, subject, body) => one(`select sales_add_email_draft($1, $2, $3, $4) as r`, [id, kind, subject, body]).then((r) => r.r);
  const L = (id, col) => val(`select ${col} from leads where id = $1`, [id]);
  const E = (id, col) => val(`select ${col} from lead_emails where id = $1`, [id]);
  const pub = (n) => ({ business_name: `Biz ${n}`, website: `https://biz${n}.com`, email: `hello@biz${n}.com`, email_source_url: `https://biz${n}.com/contact`, source: 'business_website', platform: 'shopify', country: 'United States' });
  let a, b, c, d, task;

  await step('sales: fixture (Sales Agent task)', async () => {
    const req = await val(`insert into requests (source, raw_text, status) values ('dashboard', 'Find US Shopify leads', 'in_progress') returning id`);
    task = await val(`insert into tasks (request_id, agent_id, title, instructions, work_type, status) values ($1, 'sales', 'Outreach', 'x', 'outreach-draft', 'working') returning id`, [req]);
  });

  await step('sales: LinkedIn / data brokers are refused as sources; leads dedupe by email and website', async () => {
    await assert.rejects(lead({ ...pub(9), source_url: 'https://www.linkedin.com/company/biz9' }), /check/);
    await assert.rejects(lead({ ...pub(9), email_source_url: 'https://app.apollo.io/people/1' }), /check/);
    await assert.rejects(lead({ ...pub(9), source: 'purchased_list' }), /check/);
    await assert.rejects(lead({ ...pub(9), email: 'Not An Email' }), /check/);
    a = await lead(pub(1));
    assert.equal(await lead({ ...pub(1), contact_name: 'Ana' }), a);
    assert.equal(await lead({ business_name: 'Biz 1 again', website: 'https://www.biz1.com/shop', source: 'business_website' }), a);
    assert.equal(await L(a, 'contact_name'), 'Ana');
    assert.equal(await L(a, 'stage::text'), 'found');
    b = await lead(pub(2)); c = await lead(pub(3));
    d = await lead({ business_name: 'No Source Co', website: 'https://nosource.com', email: 'info@nosource.com', source: 'business_website' });
  });

  await step('sales: research merges notes and moves found → researched', async () => {
    const r = await val(`select sales_update_research($1, '{"site_issues":["LCP 6.1 s"],"platform":"shopify"}'::jsonb, 82)`, [a]);
    assert.equal(r.stage, 'researched');
    assert.deepEqual((await L(a, 'research')).site_issues, ['LCP 6.1 s']);
    assert.equal(await L(a, 'score'), 82);
    assert.equal(await val(`select count(*)::int from lead_events where lead_id = $1 and to_stage = 'researched'`, [a]), 1);
  });

  await step('sales: SQL flag detection (pricing, discount, contract, commitment); a plain first touch is clean', async () => {
    const f = (s) => val(`select to_jsonb(sales_detect_flags('', $1))`, [s]);
    assert.deepEqual(await f('Your product pages take ~6s on mobile (PageSpeed, 3 Oct). Happy to send a free 3-point fix list. Want it?'), []);
    assert.deepEqual(await f('Our speed fix is $450 flat.'), ['pricing']);
    assert.deepEqual(await f('We can quote it this week'), ['pricing']);
    assert.deepEqual(await f('I can do 20% off for you'), ['discount']);
    assert.deepEqual(await f('We would send the agreement and a deposit link'), ['contract']);
    assert.deepEqual(await f('We can have it ready by Friday'), ['commitment']);
    assert.deepEqual(await f('Delivered within 5 business days'), ['commitment']);
    assert.deepEqual(await f('Live by Oct 14, guaranteed'), ['contract', 'commitment']);
    assert.deepEqual(await f('Your conversion rate may suffer and it costs you sales'), []);
  });

  let e1, e2, e3, e5;
  const e5ForCheck = () => e5;
  await step('sales: drafts need a published address; one open draft per kind; flagged drafts need explicit approval', async () => {
    await assert.rejects(draft(d, 'first_touch', 'Hi', 'Body'), /public source/);
    await assert.rejects(draft(a, 'follow_up', 'Hi', 'Body'), /no first email/);
    await assert.rejects(draft(a, 'reply', 'Hi', 'Body'), /no inbound message/);
    e1 = (await draft(a, 'first_touch', 'Biz 1 mobile product page', 'Hi Ana, your product page takes 6 s on mobile. Want a free fix list?')).id;
    const again = await draft(a, 'first_touch', 'Biz 1 mobile product page', 'Hi Ana, v2. Want a free fix list?');
    assert.equal(again.id, e1); assert.equal(again.replaced, true);
    assert.equal(await E(e1, 'status'), 'draft');
    assert.equal(await E(e1, 'to_email'), 'hello@biz1.com');
    e2 = (await draft(b, 'first_touch', 'Biz 2 homepage', 'Hi, quick one about your homepage hero. Want the fix list?')).id;
    const flagged = await draft(c, 'first_touch', 'Biz 3 speed', 'We fix this for $300 and can deliver by Friday.');
    e3 = flagged.id;
    assert.deepEqual(flagged.flags, ['commitment', 'pricing']);
    assert.equal(flagged.needs_explicit_approval, true);
  });

  let batch;
  await step('sales: ONE daily batch approval lists every draft; a second call the same day does nothing', async () => {
    batch = await val(`select sales_create_daily_batch('2026-09-28'::date)`);
    assert.ok(batch);
    const p = await val(`select payload from approvals where id = $1`, [batch]);
    assert.equal(p.action_type, 'sales.email_batch');
    assert.equal(p.spec.executor, 'worker');
    assert.equal(p.spec.emails.length, 3);
    assert.deepEqual(p.counts, { total: 3, flagged: 1 });
    assert.match(await val(`select title from approvals where id = $1`, [batch]), /3 emails \(1 need a closer look\)/);
    for (const e of [e1, e2, e3]) assert.equal(await E(e, 'status'), 'pending_approval');
    assert.equal(await val(`select sales_create_daily_batch('2026-09-28'::date)`), null);
    assert.equal(await val(`select count(*)::int from approvals where payload->>'action_type' = 'sales.email_batch'`), 1);
  });

  await step('sales: nothing pending approval can be claimed for sending', async () => {
    assert.equal((await val(`select sales_claim_send(20)`)).status, 'idle');
  });

  await step('sales: "Approve all" (plain decide_approval, e.g. Telegram) approves unflagged emails and holds flagged ones', async () => {
    assert.equal(await val(`select decide_approval($1, 'approve', null, 'telegram')`, [batch]), 'action_approved');
    assert.equal(await E(e1, 'status'), 'approved');
    assert.equal(await E(e2, 'status'), 'approved');
    assert.equal(await E(e3, 'status'), 'draft');
    assert.match(await E(e3, 'ceo_note'), /explicit per-email approval/);
    assert.equal(await E(e3, 'approval_id'), null);
  });

  await step('sales: per-email batch decisions (edit + approve a flagged one, reject another, rest rejected)', async () => {
    const e4 = (await draft(await lead(pub(4)), 'first_touch', 'Biz 4 checkout', 'Hi, your checkout button is below the fold on mobile. Want the fix list?')).id;
    e5 = (await draft(await lead(pub(5)), 'first_touch', 'Biz 5 hero', 'Hi, your hero video delays the page. Want the fix list?')).id;
    const b2 = await val(`select sales_create_daily_batch('2026-09-28'::date, true)`);
    assert.equal((await val(`select payload from approvals where id = $1`, [b2])).spec.emails.length, 3);
    await assert.rejects(db.query(`select sales_decide_batch($1, $2::jsonb)`, [b2, JSON.stringify([{ email_id: e1, decision: 'approve' }])]), /not waiting on this approval/);
    const res = await val(`select sales_decide_batch($1, $2::jsonb, 'reject', null, 'dashboard')`, [b2, JSON.stringify([
      { email_id: e3, decision: 'approve', body: 'Hi, your mobile LCP is 6 s. Want a free 3-point fix list?' },
      { email_id: e4, decision: 'reject', note: 'Not a fit' },
    ])]);
    assert.equal(res.result, 'action_approved');
    assert.equal(res.edited, 1);
    assert.equal(await E(e3, 'status'), 'approved');
    assert.deepEqual(await E(e3, 'flags'), []);           // flags recomputed from the edited text
    assert.equal(await E(e4, 'status'), 'rejected');
    assert.equal(await E(e5, 'status'), 'rejected');      // not listed + rest = reject
    assert.equal(await status('approvals', b2), 'approved');
    assert.equal((await val(`select sales_decide_batch($1, '[]'::jsonb)`, [b2])).result, 'already_approved');
  });

  await step('sales: sending respects the cap (SQL hard stop 50) and marks the lead contacted with a day-3 follow-up', async () => {
    assert.equal((await val(`select sales_claim_send(0)`)).status, 'cap_reached');
    assert.equal((await val(`select sales_claim_send(999)`)).cap, 50);
    await db.exec(`update lead_emails set sending_at = null`);
    const cl = await val(`select sales_claim_send(1)`);
    assert.equal(cl.status, 'claimed');
    assert.equal((await val(`select sales_claim_send(5)`)).email?.id === cl.email.id, false); // claimed row is skipped
    await db.exec(`update lead_emails set sending_at = null`);
    await val(`select sales_mark_sent($1, '<m1@out.rizehub.test>', 'julev@out.rizehub.test')`, [cl.email.id]);
    const lid = cl.email.lead_id;
    assert.equal(await L(lid, 'stage::text'), 'contacted');
    assert.ok(await val(`select abs(extract(epoch from (next_follow_up_at - first_contacted_at)) - 3*86400) < 1 from leads where id = $1`, [lid]));
    assert.equal((await val(`select sales_claim_send(1)`)).status, 'cap_reached');
    await assert.rejects(db.query(`select sales_mark_sent($1, 'x', null)`, [e5ForCheck()]), /not approved/);
  });

  await step('sales: agents cannot set contacted / proposal_sent / won / unsubscribed; replied etc. are logged', async () => {
    await assert.rejects(db.query(`select sales_move_stage($1, 'contacted', 'sales', null)`, [b]), /only after an approved email was actually sent/);
    await assert.rejects(db.query(`select sales_move_stage($1, 'won', 'sales', null)`, [b]), /only the CEO/);
    await assert.rejects(db.query(`select sales_move_stage($1, 'unsubscribed', 'sales', null)`, [b]), /only by an opt-out/);
    assert.equal((await val(`select sales_move_stage($1, 'call_booked', 'sales', 'Call Tue 9am ET')`, [b])).changed, true);
  });

  let fl;
  await step('sales: follow-ups at day 3 / 7 / 14 (one request, no duplicates), then lost as no-response', async () => {
    fl = await lead(pub(6));
    const ft = (await draft(fl, 'first_touch', 'Biz 6 speed', 'Hi, your pages are slow on mobile. Want the fix list?')).id;
    await val(`select sales_request_email_approval($1)`, [ft]);
    const ap = await E(ft, 'approval_id');
    await val(`select decide_approval($1, 'approve')`, [ap]);
    await val(`select sales_mark_sent($1, '<ft6@out>', null)`, [ft]);
    await db.exec(`update leads set first_contacted_at = now() - interval '3 days 1 hour', next_follow_up_at = now() - interval '1 hour' where id = '${fl}'`);
    await db.exec(`update leads set next_follow_up_at = null where id <> '${fl}'`);
    const q = await val(`select queue_sales_follow_ups()`);
    assert.equal(q.queued, 1);
    assert.match(await val(`select raw_text from requests where id = $1`, [q.request_id]), /Biz 6 · follow-up #1 \(day 3\)/);
    assert.equal((await val(`select queue_sales_follow_ups()`)).queued, 0); // open request → no duplicate
    for (const [n, day] of [[1, 7], [2, 14], [3, 21]]) {
      const fu = await draft(fl, 'follow_up', `Biz 6 follow-up ${n}`, 'One more thing I noticed on your collection page. Worth a look?');
      assert.equal(await E(fu.id, 'follow_up_number'), n);
      assert.equal(await E(fu.id, 'in_reply_to'), n === 1 ? '<ft6@out>' : `<fu${n - 1}@out>`);
      const r = await val(`select sales_request_email_approval($1, true)`, [fu.id]); // p_auto is ignored: the CEO approves
      assert.equal(r.auto_approved, false);
      await val(`select decide_approval($1, 'approve')`, [r.approval_id]);
      await val(`select sales_mark_sent($1, $2, null)`, [fu.id, `<fu${n}@out>`]);
      assert.equal(await L(fl, 'follow_up_count'), n);
      assert.ok(await val(`select abs(extract(epoch from (next_follow_up_at - first_contacted_at)) - $2*86400) < 1 from leads where id = $1`, [fl, day]));
    }
    await assert.rejects(draft(fl, 'follow_up', 'Again', 'Body'), /all 3 follow-ups/);
    await db.exec(`update leads set next_follow_up_at = now() - interval '1 minute' where id = '${fl}'`);
    assert.equal((await val(`select queue_sales_follow_ups()`)).closed_no_response, 1);
    assert.equal(await L(fl, 'stage::text'), 'lost');
    assert.equal(await L(fl, 'lost_reason'), 'no_response');
  });

  await step('sales: no outbound email is ever auto-approved', async () => {
    const l7 = await lead(pub(7));
    const ft = (await draft(l7, 'first_touch', 'Biz 7', 'Hi, quick one about your menu. Want the fix list?')).id;
    assert.equal((await val(`select sales_request_email_approval($1, true)`, [ft])).auto_approved, false);
    await val(`select decide_approval($1, 'approve')`, [await E(ft, 'approval_id')]);
    await val(`select sales_mark_sent($1, '<ft7@out>', null)`, [ft]);
    const fu = (await draft(l7, 'follow_up', 'Biz 7 follow-up', 'We could start on Monday for $200.')).id;
    const r = await val(`select sales_request_email_approval($1, true)`, [fu]);
    assert.equal(r.auto_approved, false);
    assert.equal(await status('approvals', r.approval_id), 'pending');
  });

  await step('sales: a reply threads by In-Reply-To, stops follow-ups and asks the Sales Agent to draft the answer', async () => {
    const l8 = await lead(pub(8));
    const ft = (await draft(l8, 'first_touch', 'Biz 8', 'Hi, your images are heavy. Want the fix list?')).id;
    await val(`select sales_request_email_approval($1)`, [ft]);
    await val(`select decide_approval($1, 'approve')`, [await E(ft, 'approval_id')]);
    await val(`select sales_mark_sent($1, '<ft8@out>', 'julev@out.test')`, [ft]);
    const fu = (await draft(l8, 'follow_up', 'Biz 8 again', 'One more finding. Worth a look?')).id;
    const res = await val(`select sales_record_inbound($1::jsonb)`, [JSON.stringify({
      message_id: '<r8@them>', in_reply_to: '<ft8@out>', references: ['<ft8@out>'], from: 'someone.else@gmail.com',
      subject: 'Re: Biz 8', body: 'Sounds good, what would it involve?', classification: 'question', classified_by: 'model' })]);
    assert.equal(res.matched, true); assert.equal(res.stage, 'replied');
    assert.equal(await L(l8, 'stage::text'), 'replied');
    assert.equal(await L(l8, 'next_follow_up_at'), null);
    assert.equal(await E(fu, 'status'), 'cancelled');
    assert.match(await val(`select raw_text from requests where id = $1`, [res.request_id]), /^Sales reply: Biz 8 replied \(question\)/);
    assert.equal(await val(`select notify from lead_events where lead_id = $1 and kind = 'reply'`, [l8]), true);
    assert.deepEqual(await val(`select sales_record_inbound($1::jsonb)`, [JSON.stringify({ message_id: '<r8@them>', from: 'x@y.com' })]), { duplicate: true });
    const rep = await draft(l8, 'reply', 'Re: Biz 8', 'Happy to explain. Would Tue 9am or Wed 3pm ET work for a 15-minute call?');
    assert.equal(await E(rep.id, 'in_reply_to'), '<r8@them>');
  });

  await step('sales: unsubscribe → permanent suppression, unsubscribed, unsent emails cancelled, no new drafts', async () => {
    const l9 = await lead({ ...pub(10), email: 'owner@biz10.com' });
    const ft = (await draft(l9, 'first_touch', 'Biz 10', 'Hi, your site is slow. Want the fix list?')).id;
    await val(`select sales_request_email_approval($1)`, [ft]);
    await val(`select decide_approval($1, 'approve')`, [await E(ft, 'approval_id')]);
    await val(`select sales_mark_sent($1, '<ft10@out>', null)`, [ft]);
    const fu = (await draft(l9, 'follow_up', 'Biz 10 again', 'One more thing. Worth a look?')).id;
    const r = await val(`select sales_record_inbound($1::jsonb)`, [JSON.stringify({ message_id: '<u10@them>', in_reply_to: '<ft10@out>', from: 'Owner@Biz10.com', subject: 'unsubscribe', body: 'remove me', classification: 'unsubscribe', classified_by: 'heuristic' })]);
    assert.equal(r.unsubscribed, true);
    assert.equal(await L(l9, 'stage::text'), 'unsubscribed');
    assert.equal(await E(fu, 'status'), 'cancelled');
    assert.equal(await val(`select count(*)::int from email_suppression where email = 'owner@biz10.com'`), 1);
    await assert.rejects(draft(l9, 'follow_up', 'x', 'y'), /unsubscribed/);
    await assert.rejects(lead({ business_name: 'Other name', email: 'owner@biz10.com', source: 'inbound' }), /suppression list/);
    await assert.rejects(db.query(`insert into lead_emails (lead_id, direction, kind, to_email, subject, body, status) values ($1, 'out', 'first_touch', 'owner@biz10.com', 's', 'b', 'draft')`, [a]), /suppression list/);
    await assert.rejects(db.query(`delete from email_suppression where email = 'owner@biz10.com'`), /permanent/);
    await assert.rejects(db.query(`update email_suppression set email = 'x@y.com' where email = 'owner@biz10.com'`), /permanent/);
    await assert.rejects(db.query(`select sales_move_stage($1, 'researched', 'ceo', null)`, [l9]), /final/);
    // an unknown sender opting out is still suppressed
    const u = await val(`select sales_record_inbound($1::jsonb)`, [JSON.stringify({ message_id: '<u11@them>', from: 'stranger@nowhere.com', subject: 'stop', body: 'unsubscribe', classification: 'unsubscribe' })]);
    assert.equal(u.matched, false); assert.equal(u.suppressed, true);
    assert.equal(await val(`select sales_is_suppressed('STRANGER@nowhere.com')`), true);
  });

  await step('sales: an approved email to an address that opted out afterwards is cancelled, never claimed', async () => {
    await db.exec(`update lead_emails set sending_at = null`);
    await val(`select sales_suppress('hello@biz2.com', 'CEO removed', 'ceo', null)`);
    assert.equal(await E(e2, 'status'), 'cancelled');
    assert.equal(await L(b, 'stage::text'), 'unsubscribed');
  });

  await step('sales: CEO marks won → client row + COO onboarding request; the agent cannot', async () => {
    const l12 = await lead(pub(12));
    await as('authenticated', CEO, async () => {
      const r = await val(`select sales_move_stage($1, 'won', 'sales', 'Signed Option B')`, [l12]);
      assert.equal(r.stage, 'won');
      assert.ok(r.client_id && r.onboarding_request_id);
      assert.equal(await val(`select name from clients where id = $1`, [r.client_id]), 'Biz 12');
      assert.match(await val(`select raw_text from requests where id = $1`, [r.onboarding_request_id]), /^Onboard Biz 12\n[\s\S]*onboarding\.md/);
      assert.equal(await val(`select actor from lead_events where lead_id = $1 and to_stage = 'won'`, [l12]), 'ceo');
    });
  });

  await step('sales: RLS: the CEO reads the pipeline but writes only through RPCs; others see nothing; worker RPCs are service-only', async () => {
    await as('authenticated', CEO, async () => {
      assert.ok(await val(`select count(*)::int from leads`) >= 10);
      assert.ok(await val(`select count(*)::int from lead_emails`) > 0);
      await assert.rejects(db.query(`insert into leads (business_name, source) values ('Hack', 'ceo')`), /row-level security|permission/);
      assert.equal((await db.query(`update leads set stage = 'won' where id = $1 returning id`, [a])).rows.length, 0);
      await assert.rejects(db.query(`select sales_claim_send(10)`), /permission denied/);
      await assert.rejects(db.query(`select sales_record_inbound('{}'::jsonb)`), /permission denied/);
    });
    await as('authenticated', OTHER, async () => {
      assert.equal(await val(`select count(*)::int from leads`), 0);
      await assert.rejects(db.query(`select sales_move_stage($1, 'lost', 'ceo', null)`, [a]), /not allowed/);
    });
    await as('anon', null, async () => {
      await assert.rejects(db.query(`select sales_suppress('a@b.com', 'x')`), /permission denied/);
    });
  });
}
