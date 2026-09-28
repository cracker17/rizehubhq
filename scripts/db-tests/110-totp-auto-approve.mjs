// M12 (supabase/migrations/20260929000000_totp_auto_approve.sql): auto-approve rules for low-risk plans (applied by
// submit_plan, audited, never for external actions) and CEO TOTP 2FA (aal2 required once enrolled, fresh TOTP
// step-up to approve high-risk external actions, Telegram/service role can't approve them once 2FA is on).
import fs from 'node:fs';

export default async function ({ db, step, val, status, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const CL_A = 'c1100000-0000-0000-0000-00000000000a';
  const CL_B = 'c1100000-0000-0000-0000-00000000000b';
  const nowSec = () => Math.floor(Date.now() / 1000);

  // Session with arbitrary JWT claims (aal, amr), like the Supabase access token.
  async function asJwt(role, claims, fn) {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [claims.sub ?? '', JSON.stringify({ role, ...claims })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  const ceoAal2 = (amr = []) => ({ sub: CEO, aal: 'aal2', amr });
  const freshTotp = () => [{ method: 'password', timestamp: nowSec() - 3600 }, { method: 'totp', timestamp: nowSec() - 5 }];

  const T = (key, work_type, agent_id = 'writer', over = {}) => ({
    key, agent_id, work_type, title: `${key} draft`, instructions: 'Write it in the brand voice.',
    acceptance_criteria: ['Keyword in H1', 'Under 900 words', 'Brand voice'], depends_on: [], ...over,
  });
  const P = (tasks, over = {}) => JSON.stringify({
    title: 'Blog pack', client_slug: null, summary: 'Three drafts for the blog queue', assumptions: [], questions_for_ceo: [],
    due_date: null, priority: 'normal', estimated_cost_usd: 0.4, tasks, ...over,
  });
  async function submit(plan, clientId = null) {
    const r = await val(`insert into requests (source, raw_text, status, client_id) values ('dashboard', 'auto-approve test', 'planning', $1) returning id`, [clientId]);
    const ap = await val(`select submit_plan($1, $2::jsonb)`, [r, plan]);
    return { r, ap };
  }
  const rule = (o) => JSON.stringify({ name: 'Cheap drafts', enabled: true, max_cost_usd: 1, max_tasks: 3, work_types: [], client_scope: 'any', client_slugs: [], ...o });
  const skippedReason = (ap) => val(`select detail->>'reason' from activity_log where action = 'plan.auto_approve_skipped' and detail->>'approval_id' = $1`, [ap]);

  // ---------- parity with packages/shared/src/autoApprove.ts ----------
  await step('auto-approve: SQL internal work types and external wording match packages/shared', async () => {
    const src = fs.readFileSync('./packages/shared/src/autoApprove.ts', 'utf8');
    const list = /AUTO_APPROVE_INTERNAL_WORK_TYPES = \[([\s\S]*?)\] as const/.exec(src)?.[1] ?? '';
    const ts = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(ts.length > 10);
    assert.deepEqual(await val(`select auto_approve_internal_work_types()`), ts);
    assert.equal(await val(`select auto_approve_external_wording()`), /EXTERNAL_WORDING = String\.raw`([^`]*)`/.exec(src)?.[1]);
    const roster = fs.readFileSync('./agents/roster.yaml', 'utf8');
    for (const wt of ts) assert.match(roster, new RegExp(`^\\s+${wt}:`, 'm'), `${wt} is a roster work type`);
  });

  await step('auto-approve: fixtures (two clients); the old boolean setting is gone', async () => {
    await db.exec(`insert into clients (id, name, slug) values ('${CL_A}', 'Auto A', 'auto-a'), ('${CL_B}', 'Auto B', 'auto-b')`);
    assert.equal(await val(`select count(*)::int from settings where key = 'auto_approve_plans'`), 0);
  });

  // ---------- default: nothing auto-approves ----------
  await step('auto-approve: no rules (default) → a cheap internal plan still waits for the CEO', async () => {
    assert.equal(await val(`select count(*)::int from plan_auto_approve_rules`), 0);
    const { r, ap } = await submit(P([T('a', 'seo-article')]));
    assert.equal(await status('approvals', ap), 'pending');
    assert.equal(await status('requests', r), 'plan_review');
    await db.query(`select decide_approval($1, 'reject', null)`, [ap]);
  });

  let ruleId;
  await step('auto-approve: save_auto_approve_rule validates (internal work types only, known clients, listed needs clients)', async () => {
    await assert.rejects(db.query(`select save_auto_approve_rule($1::jsonb)`, [rule({ work_types: ['shopify-page'] })]), /not internal-only/);
    await assert.rejects(db.query(`select save_auto_approve_rule($1::jsonb)`, [rule({ client_scope: 'listed', client_slugs: ['nope'] })]), /unknown client/);
    await assert.rejects(db.query(`select save_auto_approve_rule($1::jsonb)`, [rule({ client_scope: 'listed', client_slugs: [] })]), /check/);
    await assert.rejects(db.query(`select save_auto_approve_rule($1::jsonb)`, [rule({ max_cost_usd: 500 })]), /check/);
    ruleId = await val(`select save_auto_approve_rule($1::jsonb)`, [rule({ work_types: ['seo-article', 'meta-tags'] })]);
    assert.equal(await val(`select count(*)::int from activity_log where action = 'auto_approve.rule_saved' and detail->>'rule_id' = $1`, [ruleId]), 1);
  });

  await step('auto-approve: a matching plan is approved server-side by submit_plan, with an audit trail naming the rule', async () => {
    const { r, ap } = await submit(P([T('a', 'seo-article'), T('b', 'meta-tags', 'writer', { depends_on: ['a'] })]));
    assert.equal(await status('approvals', ap), 'approved');
    assert.equal(await val(`select decided_via from approvals where id = $1`, [ap]), 'auto');
    assert.equal(await val(`select payload->'auto_approved'->>'rule_name' from approvals where id = $1`, [ap]), 'Cheap drafts');
    assert.equal(await val(`select payload->'auto_approved'->>'rule_id' from approvals where id = $1`, [ap]), ruleId);
    assert.match(await val(`select ceo_note from approvals where id = $1`, [ap]), /Auto-approved by rule "Cheap drafts"/);
    const log = await val(`select detail from activity_log where action = 'plan.auto_approved' and detail->>'approval_id' = $1`, [ap]);
    assert.equal(log.rule_name, 'Cheap drafts');
    assert.equal(log.rule_id, ruleId);
    assert.equal(await val(`select actor from activity_log where action = 'approval.approved' and detail->>'approval_id' = $1`, [ap]), 'system');
    assert.equal(await status('requests', r), 'in_progress');
    assert.equal(await val(`select count(*)::int from tasks where request_id = $1`, [r]), 2);
    assert.equal(await val(`select count(*)::int from tasks where request_id = $1 and status = 'queued'`, [r]), 1);
    assert.equal(await val(`select status::text from agents where id = 'coo'`), 'idle');
  });

  await step('auto-approve: over the cost cap, too many tasks or another work type → the CEO decides', async () => {
    const over = await submit(P([T('a', 'seo-article')], { estimated_cost_usd: 1.5 }));
    assert.equal(await status('approvals', over.ap), 'pending');
    const many = await submit(P(['a', 'b', 'c', 'd'].map((k) => T(k, 'seo-article'))));
    assert.equal(await status('approvals', many.ap), 'pending');
    const other = await submit(P([T('a', 'wireframe', 'designer')]));
    assert.equal(await status('approvals', other.ap), 'pending', 'wireframe is internal but not in this rule');
    for (const x of [over, many, other]) await db.query(`select decide_approval($1, 'reject', null)`, [x.ap]);
  });

  await step('auto-approve: never for work that touches client systems (web-dev), questions, missing cost, or external wording', async () => {
    await db.query(`select save_auto_approve_rule($1::jsonb)`, [rule({ name: 'Any internal', max_cost_usd: 5, max_tasks: null })]);
    const dev = await submit(P([T('a', 'seo-article'), T('b', 'shopify-page', 'web-dev')]));
    assert.equal(await status('approvals', dev.ap), 'pending');
    assert.match(await skippedReason(dev.ap), /task b \(shopify-page\) is not internal-only work/);
    const pub = await submit(P([T('a', 'seo-article', 'writer', { instructions: 'Write it, then publish it on the blog.' })]));
    assert.equal(await status('approvals', pub.ap), 'pending');
    assert.match(await skippedReason(pub.ap), /task a mentions "publish"/);
    const send = await submit(P([T('a', 'dm-reply-draft', 'sales', { acceptance_criteria: ['Tone', 'Length', 'Sent to the lead'] })]));
    assert.match(await skippedReason(send.ap), /mentions "Sent"/);
    const ask = await submit(P([T('a', 'seo-article')], { questions_for_ceo: ['Which keyword?'] }));
    assert.match(await skippedReason(ask.ap), /questions for the CEO/);
    const nocost = await submit(JSON.stringify({ ...JSON.parse(P([T('a', 'seo-article')])), estimated_cost_usd: null }));
    assert.match(await skippedReason(nocost.ap), /no cost estimate/);
    for (const x of [dev, pub, send, ask, nocost]) {
      assert.equal(await status('approvals', x.ap), 'pending');
      await db.query(`select decide_approval($1, 'reject', null)`, [x.ap]);
    }
  });

  await step('auto-approve: client scope (listed / none) and disabled rules', async () => {
    await db.exec(`update plan_auto_approve_rules set enabled = false`);
    const listed = await val(`select save_auto_approve_rule($1::jsonb)`, [rule({ name: 'Client A copy', client_scope: 'listed', client_slugs: ['auto-a'] })]);
    const b = await submit(P([T('a', 'seo-article')]), CL_B);
    assert.equal(await status('approvals', b.ap), 'pending');
    const noClient = await submit(P([T('a', 'seo-article')]));
    assert.equal(await status('approvals', noClient.ap), 'pending');
    const a = await submit(P([T('a', 'seo-article')]), CL_A);
    assert.equal(await status('approvals', a.ap), 'approved');
    assert.equal(await val(`select payload->'auto_approved'->>'rule_name' from approvals where id = $1`, [a.ap]), 'Client A copy');

    await db.query(`select save_auto_approve_rule($1::jsonb)`, [rule({ id: listed, name: 'Internal only', client_scope: 'none', client_slugs: ['auto-a'] })]);
    assert.deepEqual(await val(`select client_slugs from plan_auto_approve_rules where id = $1`, [listed]), [], 'slugs dropped unless listed');
    const a2 = await submit(P([T('a', 'seo-article')]), CL_A);
    assert.equal(await status('approvals', a2.ap), 'pending');
    const internal = await submit(P([T('a', 'seo-article')]));
    assert.equal(await status('approvals', internal.ap), 'approved');

    await db.query(`select save_auto_approve_rule($1::jsonb)`, [rule({ id: listed, name: 'Internal only', enabled: false, client_scope: 'none' })]);
    const off = await submit(P([T('a', 'seo-article')]));
    assert.equal(await status('approvals', off.ap), 'pending', 'every rule is off');
    for (const x of [b, noClient, a2, off]) await db.query(`select decide_approval($1, 'reject', null)`, [x.ap]);
    await db.exec(`update plan_auto_approve_rules set enabled = true where id = '${ruleId}'`);
  });

  await step('auto-approve: external actions are NEVER auto-approved ("auto" is refused for anything but a rule-matched plan)', async () => {
    const r = await val(`insert into requests (source, raw_text, status) values ('dashboard', 'ext', 'in_progress') returning id`);
    const t = await val(`insert into tasks (request_id, agent_id, title, instructions, work_type, status, heartbeat_at, acceptance_criteria)
                         values ($1, 'writer', 'w', 'x', 'seo-article', 'working', now(), '["a"]') returning id`, [r]);
    const act = await val(`select request_external_action($1, 'publish_wordpress', '{"description":"Publish the post"}'::jsonb)`, [t]);
    assert.equal(await status('approvals', act), 'pending');
    assert.equal(await val(`select auto_approve_plan($1)`, [act]), null);
    assert.equal(await status('approvals', act), 'pending');
    await assert.rejects(db.query(`select decide_approval($1, 'approve', null, 'auto')`, [act]), /only for plans/);
    await db.query(`select set_config('hq.auto_approving', $1, false)`, [act]);
    await assert.rejects(db.query(`select decide_approval($1, 'approve', null, 'auto')`, [act]), /only for plans/);
    await db.query(`select set_config('hq.auto_approving', '', false)`);
    const plan = await submit(P([T('a', 'wireframe', 'designer')]));
    await assert.rejects(db.query(`select decide_approval($1, 'approve', null, 'auto')`, [plan.ap]), /only for plans, by an auto-approve rule/);
    assert.equal(await status('approvals', act), 'pending');
    await db.query(`select decide_approval($1, 'reject', null)`, [act]);
    await db.query(`select decide_approval($1, 'reject', null)`, [plan.ap]);
  });

  await step('auto-approve: the browser cannot write approvals or rules directly, nor call the internal helpers', () => as('authenticated', CEO, async () => {
    await assert.rejects(db.query(`update approvals set status = 'approved' where status = 'pending'`), /permission denied/);
    await assert.rejects(db.query(`insert into plan_auto_approve_rules (name, max_cost_usd) values ('x', 1)`), /permission denied/);
    await assert.rejects(db.query(`select auto_approve_plan(gen_random_uuid())`), /permission denied/);
    assert.ok(await val(`select count(*)::int from plan_auto_approve_rules`) >= 2, 'the CEO can read the rules');
    await db.query(`select delete_auto_approve_rule($1)`, [ruleId]);
    assert.equal(await val(`select count(*)::int from plan_auto_approve_rules where id = $1`, [ruleId]), 0);
  }));

  // ---------- TOTP ----------
  let high, high2, question, rTask;
  await step('totp: fixtures (Supabase auth.mfa_factors stub, pending high-risk actions and a question)', async () => {
    await db.exec(`create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null, factor_type text not null, status text not null)`);
    const r = await val(`insert into requests (source, raw_text, status) values ('dashboard', 'totp', 'in_progress') returning id`);
    const mk = () => val(`insert into tasks (request_id, agent_id, title, instructions, work_type, status, heartbeat_at, acceptance_criteria)
                          values ($1, 'writer', 'w', 'x', 'seo-article', 'working', now(), '["a"]') returning id`, [r]);
    rTask = await mk();
    high = await val(`select request_external_action($1, 'merge_pr', '{"description":"Merge PR #12"}'::jsonb)`, [rTask]);
    high2 = await val(`select request_external_action($1, 'publish_theme', '{"description":"Publish theme"}'::jsonb)`, [rTask]);
    question = await val(`select ask_ceo($1, 'Which title?', '["A","B"]'::jsonb)`, [await mk()]);
    assert.equal(await val(`select approval_is_high_risk(a) from approvals a where id = $1`, [high]), true);
    assert.equal(await val(`select approval_is_high_risk(a) from approvals a where id = $1`, [question]), false);
  });

  await step('totp: not enrolled → nothing changes (CEO aal1 and Telegram can still approve high-risk actions)', async () => {
    await asJwt('authenticated', { sub: CEO, aal: 'aal1' }, async () => {
      assert.equal(await val('select count(*)::int from agents'), 6);
      assert.deepEqual(await val(`select ceo_step_up_status()`), { enrolled: false, fresh: false, aal: 'aal1' });
    });
    await as('service_role', null, async () => {
      assert.equal(await val(`select decide_approval($1, 'approve', null, 'telegram')`, [high2]), 'action_approved');
    });
  });

  await step('totp: once enrolled, an aal1 session is not the CEO (RLS + workflow RPCs)', async () => {
    await db.query(`insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', 'unverified')`, [CEO]);
    await asJwt('authenticated', { sub: CEO, aal: 'aal1' }, async () => {
      assert.equal(await val('select count(*)::int from agents'), 6, 'an unverified factor does not count');
    });
    await db.query(`update auth.mfa_factors set status = 'verified' where user_id = $1`, [CEO]);
    await asJwt('authenticated', { sub: CEO, aal: 'aal1' }, async () => {
      assert.equal(await val('select count(*)::int from agents'), 0);
      await assert.rejects(db.query(`select create_request('dashboard', 'x')`), /not allowed/);
    });
    await asJwt('authenticated', ceoAal2(), async () => {
      assert.equal(await val('select count(*)::int from agents'), 6);
      assert.deepEqual(await val(`select ceo_step_up_status()`), { enrolled: true, fresh: false, aal: 'aal2' });
    });
  });

  await step('totp: approving a high-risk action needs a fresh TOTP (≤ 5 min); reject and non-risky answers do not', async () => {
    await asJwt('authenticated', ceoAal2([{ method: 'password', timestamp: nowSec() }]), async () => {
      await assert.rejects(db.query(`select decide_approval($1, 'approve', null, 'dashboard')`, [high]), /step_up_required/);
      assert.equal(await val(`select decide_approval($1, 'approve', 'A', 'dashboard')`, [question]), 'action_approved');
    });
    await asJwt('authenticated', ceoAal2([{ method: 'totp', timestamp: nowSec() - 600 }]), async () => {
      await assert.rejects(db.query(`select decide_approval($1, 'approve', null, 'dashboard')`, [high]), /step_up_required/);
    });
    await asJwt('authenticated', ceoAal2(['totp']), async () => {
      await assert.rejects(db.query(`select decide_approval($1, 'approve', null, 'dashboard')`, [high]), /step_up_required/, 'string amr has no timestamp');
    });
    assert.equal(await status('approvals', high), 'pending');
    await asJwt('authenticated', ceoAal2(freshTotp()), async () => {
      assert.equal((await val(`select ceo_step_up_status()`)).fresh, true);
      assert.equal(await val(`select decide_approval($1, 'approve', null, 'dashboard')`, [high]), 'action_approved');
    });
  });

  await step('totp: Telegram (service role) cannot approve high-risk actions once 2FA is on, but can reject them', async () => {
    const a = await val(`select request_external_action($1, 'deploy', '{"description":"Deploy"}'::jsonb)`, [rTask]);
    const b = await val(`select request_external_action($1, 'spend', '{"description":"Buy a domain"}'::jsonb)`, [rTask]);
    await as('service_role', null, async () => {
      await assert.rejects(db.query(`select decide_approval($1, 'approve', null, 'telegram')`, [a]), /step_up_required/);
      assert.equal(await val(`select decide_approval($1, 'reject', null, 'telegram')`, [b]), 'action_rejected');
      assert.equal(await val(`select decide_approval($1, 'changes', 'smaller', 'telegram')`, [a]), 'action_changes_requested');
    });
  });

  await step('totp: turning an auto-approve rule on needs the step-up; turning one off does not; SQL editor sessions are exempt', async () => {
    await asJwt('authenticated', ceoAal2(), async () => {
      await assert.rejects(db.query(`select save_auto_approve_rule($1::jsonb)`, [rule({ name: 'Needs 2FA' })]), /step_up_required/);
      assert.ok(await val(`select save_auto_approve_rule($1::jsonb)`, [rule({ name: 'Off rule', enabled: false })]));
    });
    await asJwt('authenticated', ceoAal2(freshTotp()), async () => {
      assert.ok(await val(`select save_auto_approve_rule($1::jsonb)`, [rule({ name: 'With 2FA' })]));
    });
    const c = await val(`select request_external_action($1, 'publish', '{"description":"Publish"}'::jsonb)`, [rTask]);
    assert.equal(await val(`select decide_approval($1, 'approve', null, 'dashboard')`, [c]), 'action_approved', 'direct DB session');
  });

  await step('totp: recovery = delete the factor with the service role → back to password-only', async () => {
    await db.query(`delete from auth.mfa_factors where user_id = $1`, [CEO]);
    await asJwt('authenticated', { sub: CEO, aal: 'aal1' }, async () => {
      assert.equal(await val('select count(*)::int from agents'), 6);
    });
    await db.exec(`drop table auth.mfa_factors; delete from plan_auto_approve_rules;`);
  });
}
