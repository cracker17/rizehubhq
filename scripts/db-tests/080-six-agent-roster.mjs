// Six-agent roster (supabase/migrations/20260928080000_six_agent_roster.sql).
// Builds its own database at the state just before that migration, with the old 22-agent team and rows that point
// at the deleted agents, then applies the migration and checks every row landed on its new owner.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

const MIG = '20260928080000_six_agent_roster.sql';
const SIX = ['coo', 'designer', 'qa-lead', 'sales', 'web-dev', 'writer'];
const OLD = ['ea', 'client-success', 'pipeline', 'prospector', 'inbound', 'job-scout', 'shopify-dev', 'webflow-dev', 'wordpress-dev',
  'fullstack-dev', 'uiux-1', 'uiux-2', 'graphic-1', 'graphic-2', 'social-1', 'social-2', 'seo-1', 'seo-2', 'video-editor', 'sound-engineer'];

export default async function ({ db: mainDb, step, assert, stub, as }) {
  const db = new PGlite();
  const val = async (sql, params) => Object.values((await db.query(sql, params)).rows[0] ?? {})[0];
  const col = async (sql, params) => (await db.query(sql, params)).rows.map((r) => Object.values(r)[0]);
  const migDir = './supabase/migrations';
  const CL = 'c8000000-0000-0000-0000-000000000001';
  let req, reqVideo, reqPlan, apPlan, t = {}, apFailed, apDeliv, cred;

  await step('roster: database at the pre-roster state with the old 22 agents', async () => {
    await db.exec(stub);
    for (const f of fs.readdirSync(migDir).filter((f) => f.endsWith('.sql') && f < MIG).sort()) {
      await db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }
    const rows = ['coo', 'qa-lead', ...OLD].map((id) => `('${id}', '${id}', 'x', 'specialist')`).join(',');
    await db.exec(`insert into agents (id, name, department, model_role) values ${rows}`);
    assert.equal(await val('select count(*)::int from agents'), 22);
  });

  await step('roster: fixture rows owned by deleted agents', async () => {
    await db.exec(`insert into clients (id, name, slug) values ('${CL}', 'Roster Co', 'roster-co')`);
    const newReq = (text, st = 'in_progress') =>
      val(`insert into requests (source, raw_text, status, client_id) values ('dashboard', $1, $2, '${CL}') returning id`, [text, st]);
    const mk = (r, agentId, wt, st) => val(`insert into tasks (request_id, client_id, agent_id, title, instructions, work_type, status, heartbeat_at, claimed_at)
      values ($1, '${CL}', $2, $3, 'x', $4, $5, now(), now()) returning id`, [r, agentId, `${agentId} ${wt}`, wt, st]);
    req = await newReq('Launch bundle');
    t.copy = await mk(req, 'seo-1', 'landing-copy', 'done');
    t.section = await mk(req, 'shopify-dev', 'shopify-section', 'working');
    t.wire = await mk(req, 'uiux-1', 'wireframe', 'queued');
    t.banner = await mk(req, 'graphic-1', 'ad-creative', 'awaiting_ceo');
    t.reel = await mk(req, 'video-editor', 'reel', 'queued');
    t.vo = await mk(req, 'sound-engineer', 'voiceover', 'done');
    reqVideo = await newReq('Promo video only');
    t.edit = await mk(reqVideo, 'video-editor', 'video-edit', 'failed');
    apFailed = await val(`insert into approvals (kind, request_id, task_id, agent_id, title, payload)
      values ('external_action', $1, $2, 'video-editor', 'Stuck: edit', '{"type":"task_failed","pauses_task":true}') returning id`, [reqVideo, t.edit]);
    apDeliv = await val(`insert into approvals (kind, request_id, task_id, agent_id, title)
      values ('deliverable', $1, $2, 'graphic-1', 'Banner') returning id`, [req, t.banner]);
    await db.query(`insert into qa_reviews (task_id, reviewer_id, attempt, verdict, score, checks) values ($1, 'seo-2', 1, 'pass', 90, '[]')`, [t.copy]);

    reqPlan = await newReq('Blog + socials', 'plan_review');
    apPlan = await val(`insert into approvals (kind, request_id, agent_id, title, payload) values ('plan', $1, 'coo', 'Plan',
      '{"tasks":[{"key":"a","agent_id":"seo-1","work_type":"seo-article","title":"a"},{"key":"b","agent_id":"social-1","work_type":"social-captions","title":"b"}]}')
      returning id`, [reqPlan]);

    await db.exec(`insert into reports (agent_id, report_date, kind, done, next, body_md, cost_usd) values
      ('seo-1', '2026-09-27', 'standup', '["post A"]', '["post B"]', 'seo-1 notes', 0.10),
      ('seo-2', '2026-09-27', 'standup', '["post C"]', '[]', 'seo-2 notes', 0.05),
      ('ea', '2026-09-27', 'daily_digest', '[]', '[]', 'digest', 0.20)`);
    cred = await val(`insert into client_credentials (client_id, platform, label, secret_type, secret_cipher, secret_iv)
      values ('${CL}', 'shopify', 'Roster Shopify', 'password', '\\x00', '\\x00') returning id`);
    await db.query(`insert into credential_grants (credential_id, agent_id) values ($1, 'shopify-dev'), ($1, 'webflow-dev'), ($1, 'qa-lead')`, [cred]);
    await db.query(`insert into agent_messages (agent_id, sender, body, task_id) values ('seo-1', 'agent', 'Copy ready', $1)`, [t.copy]);
    await db.query(`insert into agent_screens (agent_id, task_id, app) values ('shopify-dev', $1, 'editor')`, [t.section]);
    await db.exec(`insert into activity_log (actor, action) values ('seo-1', 'task.submitted')`);
  });

  await step(`roster: migration ${MIG} applies`, () => db.exec(fs.readFileSync(path.join(migDir, MIG), 'utf8')));

  await step('roster: exactly the 6 agents remain, with runtime, model role and desk', async () => {
    assert.deepEqual(await col('select id from agents order by id'), SIX);
    const rows = (await db.query('select id, name, department, model_role, runtime, desk from agents order by id')).rows;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.deepEqual([by['web-dev'].name, by['web-dev'].department, by['web-dev'].model_role, by['web-dev'].runtime], ['Web Developer', 'dev', 'dev', 'hermes']);
    assert.deepEqual([by.coo.runtime, by['qa-lead'].runtime, by.sales.runtime], ['worker', 'worker', 'hermes']);
    assert.deepEqual(rows.map((r) => [r.id, r.desk.id]),
      [['coo', 'board-head'], ['designer', 'design-1'], ['qa-lead', 'qa-1'], ['sales', 'sales-2'], ['web-dev', 'dev-1'], ['writer', 'sales-1']]);
    await assert.rejects(db.query(`update agents set runtime = 'docker' where id = 'coo'`), /check/);
  });

  await step('roster: nothing references a deleted agent any more', async () => {
    for (const [table, c] of [['tasks', 'agent_id'], ['qa_reviews', 'reviewer_id'], ['approvals', 'agent_id'], ['reports', 'agent_id'],
      ['credential_grants', 'agent_id'], ['agent_messages', 'agent_id'], ['agent_screens', 'agent_id']]) {
      assert.equal(await val(`select count(*)::int from ${table} where ${c} = any($1)`, [OLD]), 0, table);
    }
  });

  await step('roster: tasks move to their new owner; a running task goes back to the queue', async () => {
    const owner = async (id) => (await db.query('select agent_id, status::text from tasks where id = $1', [id])).rows[0];
    assert.deepEqual(await owner(t.copy), { agent_id: 'writer', status: 'done' });
    assert.deepEqual(await owner(t.section), { agent_id: 'web-dev', status: 'queued' });
    assert.equal(await val('select heartbeat_at from tasks where id = $1', [t.section]), null);
    assert.deepEqual(await owner(t.wire), { agent_id: 'designer', status: 'queued' });
    assert.deepEqual(await owner(t.banner), { agent_id: 'designer', status: 'awaiting_ceo' });
    assert.deepEqual(await owner(t.vo), { agent_id: 'writer', status: 'done' }, 'history keeps its status');
    assert.equal(await val('select agent_id from approvals where id = $1', [apDeliv]), 'designer');
    assert.equal(await val('select status::text from approvals where id = $1', [apDeliv]), 'pending');
    assert.equal(await val(`select reviewer_id from qa_reviews where task_id = $1`, [t.copy]), 'writer');
    assert.equal(await val(`select agent_id from agent_messages where task_id = $1`, [t.copy]), 'writer');
  });

  await step('roster: open work of removed types is cancelled with a reason; a request left with nothing open closes', async () => {
    assert.equal(await val('select status::text from tasks where id = $1', [t.reel]), 'cancelled');
    assert.match(await val(`select qa_feedback->>'cancelled_reason' from tasks where id = $1`, [t.reel]), /6 agents.*\(reel\)/);
    assert.equal(await val('select status::text from tasks where id = $1', [t.edit]), 'cancelled');
    assert.equal(await val('select status::text from approvals where id = $1', [apFailed]), 'rejected');
    assert.equal(await val('select status::text from requests where id = $1', [reqVideo]), 'cancelled');
    assert.equal(await val('select status::text from requests where id = $1', [req]), 'in_progress', 'other work is still open');
    assert.equal(await val(`select count(*)::int from activity_log where action = 'task.cancelled'`), 2);
  });

  await step('roster: a pending plan naming old agents goes back to the COO to replan', async () => {
    assert.equal(await val('select status::text from approvals where id = $1', [apPlan]), 'changes_requested');
    assert.equal(await val('select status::text from requests where id = $1', [reqPlan]), 'staged');
    assert.match(await val(`select brief->'ceo_feedback'->>0 from requests where id = $1`, [reqPlan]), /replan with the new roster/);
  });

  await step('roster: same-day reports merge into the new owner; grants merge; POV rows dropped; audit log untouched', async () => {
    const standup = (await db.query(`select done, next, body_md, cost_usd, data from reports where agent_id = 'writer' and kind = 'standup'`)).rows;
    assert.equal(standup.length, 1);
    assert.deepEqual(standup[0].done, ['post A', 'post C']);
    assert.deepEqual(standup[0].next, ['post B']);
    assert.equal(standup[0].body_md, 'seo-1 notes\n\nseo-2 notes');
    assert.equal(Number(standup[0].cost_usd), 0.15);
    assert.deepEqual(standup[0].data.merged_from, ['seo-1', 'seo-2']);
    assert.equal(await val(`select body_md from reports where agent_id = 'coo' and kind = 'daily_digest'`), 'digest');
    assert.deepEqual(await col('select agent_id from credential_grants where credential_id = $1 order by 1', [cred]), ['qa-lead', 'web-dev']);
    assert.equal(await val('select count(*)::int from agent_screens'), 0);
    assert.equal(await val(`select count(*)::int from activity_log where actor = 'seo-1'`), 1);
  });

  await step('roster: agent statuses are recomputed', async () => {
    assert.equal(await val(`select status::text from agents where id = 'web-dev'`), 'idle');
    assert.equal(await val(`select current_task_id from agents where id = 'web-dev'`), null);
    assert.equal(await val(`select status::text from agents where id = 'designer'`), 'waiting'); // pending deliverable approval
  });

  await step('roster: job + follow-up text names the Sales Agent', async () => {
    const j = await val(`insert into job_opportunities (source, title, url, status, applied_at, follow_up_at)
      values ('onlinejobs', 'Shopify dev', 'https://example.com/j/1', 'applied', now() - interval '6 days', now() - interval '1 day') returning id`);
    assert.equal(await val('select queue_job_follow_ups()'), 1);
    assert.match(await val(`select raw_text from requests where source = 'schedule' order by created_at desc limit 1`), /\nSales Agent: follow/);
    await val(`select set_job_status($1, 'replied')`, [j]);
    assert.equal(await val(`select actor from activity_log where action = 'job.replied'`), 'sales');
    await db.query(`select store_webhook_event('ev-roster', 'lead.replied', '{"data":{"lead_id":"ld_9","company":"Kinfolk"}}'::jsonb, true)`);
    const ev = await val(`select id from webhook_events where event_id = 'ev-roster'`);
    const res = await val(`select process_rizehub_event($1)`, [ev]);
    assert.match(await val('select raw_text from requests where id = $1', [res.request_id]), /^Pipeline follow-up: Kinfolk replied[\s\S]*\nSales Agent: read the thread/);
  });

  await step('budget alerts: record_budget_alert stores one row per day and level (worker only); the bot marks it sent', async () => {
    const rec = (day, level) => mainDb.query(`select record_budget_alert($1::date, $2, 8.25, 10)`, [day, level]).then((r) => r.rows[0].record_budget_alert);
    await as('service_role', null, async () => {
      assert.equal(await rec('2026-09-28', 80), true);
      assert.equal(await rec('2026-09-28', 80), false);
      assert.equal(await rec('2026-09-28', 100), true);
      await mainDb.exec(`update budget_alerts set telegram_sent_at = now() where alert_day = '2026-09-28' and level = 80`);
    });
    assert.deepEqual((await mainDb.query(`select level, telegram_sent_at is null as unsent from budget_alerts order by level`)).rows,
      [{ level: 80, unsent: false }, { level: 100, unsent: true }]);
    await assert.rejects(mainDb.query(`insert into budget_alerts (alert_day, level, spent_usd, budget_usd) values ('2026-09-29', 50, 1, 1)`), /check/);
    for (const [role, uid] of [['anon', null], ['authenticated', '11111111-1111-1111-1111-111111111111']]) {
      await as(role, uid, async () => { await assert.rejects(rec('2026-09-29', 80), /permission denied/); });
    }
    await as('authenticated', '22222222-2222-2222-2222-222222222222', async () => {
      assert.equal((await mainDb.query('select count(*)::int as n from budget_alerts')).rows[0].n, 0); // RLS: not the CEO
    });
  });

  await step('roster: seed.sql on top of the migration is an idempotent upsert', async () => {
    await db.exec(fs.readFileSync('./supabase/seed.sql', 'utf8').replace(/insert into settings[\s\S]*$/, ''));
    assert.deepEqual(await col('select id from agents order by id'), SIX);
  });
  await db.close();
}
