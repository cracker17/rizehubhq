// M7 reports + Telegram (supabase/migrations/20260928030000_reports_telegram.sql).
// Uses a past date (2026-01-15, Manila) so rows from the main suite (created "now") never leak into the window.
export default async function ({ db, step, one, val, as, assert }) {
  const D = '2026-01-15';
  // Manila is UTC+8: the window is 2026-01-14T16:00Z .. 2026-01-15T16:00Z.
  let req, tDone, tDone2, tWork, tFail;

  await step('reports: morning_brief kind allowed, unknown kinds refused', async () => {
    await db.exec(`insert into reports (agent_id, report_date, kind) values ('ea', '2020-01-01', 'morning_brief')`);
    await assert.rejects(db.query(`insert into reports (agent_id, report_date, kind) values ('ea', '2020-01-01', 'monthly')`), /check/);
  });

  await step('reports: one digest per day even without an agent (null agent_id)', async () => {
    await db.exec(`insert into reports (agent_id, report_date, kind) values (null, '2020-01-02', 'daily_digest')`);
    await assert.rejects(db.query(`insert into reports (agent_id, report_date, kind) values (null, '2020-01-02', 'daily_digest')`), /duplicate|unique/);
  });

  await step('settings defaults: paused=false, quiet hours 22:00–07:00', async () => {
    assert.equal(await val(`select value from settings where key = 'paused'`), false);
    assert.deepEqual(await val(`select value from settings where key = 'quiet_hours'`), { start: '22:00', end: '07:00' });
    assert.equal(await val(`select value from settings where key = 'digest_time'`), '18:00');
  });

  await step('report_facts: fixture for 2026-01-15 (Manila)', async () => {
    await db.exec(`insert into clients (id, name, slug) values ('c0000000-0000-0000-0000-000000000001', 'Madam Muse', 'madam-muse-r')`);
    req = await val(`insert into requests (source, raw_text, title, client_id, status, priority, created_at)
                     values ('dashboard', 'Bundle page', 'Bundle page', 'c0000000-0000-0000-0000-000000000001', 'in_progress', 'high',
                             '2026-01-15T01:00:00Z') returning id`);
    const mk = async (agentId, title, status, extra = '') => val(
      `insert into tasks (request_id, client_id, agent_id, title, instructions, work_type, status ${extra ? ',' + extra.split('|')[0] : ''})
       values ($1, 'c0000000-0000-0000-0000-000000000001', $2, $3, 'x', 'landing-copy', $4 ${extra ? ',' + extra.split('|')[1] : ''}) returning id`,
      [req, agentId, title, status]);
    tDone = await mk('seo-1', 'Landing copy', 'done', `completed_at, started_at|'2026-01-15T03:00:00Z', '2026-01-15T01:00:00Z'`);
    // completed 23:30 Manila on the 15th → inside; 00:30 Manila on the 16th → outside
    tDone2 = await mk('graphic-1', 'Hero banner', 'done', `completed_at|'2026-01-15T15:30:00Z'`);
    await mk('graphic-1', 'Late banner', 'done', `completed_at|'2026-01-15T16:30:00Z'`);
    tWork = await mk('uiux-1', 'Wireframe', 'working', `started_at|'2026-01-15T02:00:00Z'`);
    tFail = await mk('shopify-dev', 'Build section', 'failed');
    await db.query(`insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
                    values ('external_action', $1, $2, 'shopify-dev', 'Stuck: Build section', 'Missing theme access', '{"type":"task_failed"}')`, [req, tFail]);
    // spend: two rows inside the window, one the minute after it closes
    await db.exec(`insert into activity_log (actor, action, task_id, client_id, cost_usd, created_at) values
      ('seo-1', 'usage.task', '${tDone}', 'c0000000-0000-0000-0000-000000000001', 0.5, '2026-01-14T16:00:00Z'),
      ('graphic-1', 'usage.task', '${tDone2}', null, 0.25, '2026-01-15T15:59:00Z'),
      ('graphic-1', 'usage.task', '${tDone2}', null, 9, '2026-01-15T16:00:00Z'),
      ('seo-1', 'task.submitted', '${tDone}', null, 0, '2026-01-15T02:30:00Z'),
      ('qa-lead', 'qa.pass', '${tDone}', null, 0, '2026-01-15T02:40:00Z')`);
    await db.exec(`insert into qa_reviews (task_id, reviewer_id, attempt, verdict, score, checks, created_at) values
      ('${tDone}', 'qa-lead', 1, 'fail', 60, '[]', '2026-01-15T02:00:00Z'),
      ('${tDone}', 'qa-lead', 2, 'pass', 92, '[]', '2026-01-15T02:40:00Z'),
      ('${tDone}', 'qa-lead', 3, 'pass', 95, '[]', '2026-01-16T02:40:00Z')`);
  });

  let f;
  await step('report_facts: done / spend / QA / clients are exact for the Manila day', async () => {
    f = await val(`select report_facts($1::date)`, [D]);
    assert.equal(f.tz, 'Asia/Manila');
    assert.deepEqual(f.done.map((d) => d.title).sort(), ['Hero banner', 'Landing copy']);
    assert.equal(f.done.find((d) => d.title === 'Landing copy').client_name, 'Madam Muse');
    assert.equal(Number(f.spend_usd), 0.75);
    assert.deepEqual(f.spend_by_actor.map((s) => [s.actor, Number(s.usd)]), [['seo-1', 0.5], ['graphic-1', 0.25]]);
    assert.deepEqual(f.spend_by_client.map((s) => [s.name, Number(s.usd)]), [['Madam Muse', 0.5]]);
    assert.deepEqual(f.qa, { reviews: 2, passed: 1 });
    assert.equal(f.requests_created, 1);
    assert.deepEqual(f.events.map((e) => `${e.actor}:${e.action}`), ['seo-1:task.submitted', 'qa-lead:qa.pass']);
    assert.equal(f.events[0].task_title, 'Landing copy');
  });

  await step('report_facts: live lists (in progress, blocked with reason, approvals waiting)', async () => {
    assert.ok(f.in_progress.some((t) => t.task_id === tWork && t.status === 'working'));
    const b = f.blocked.find((t) => t.task_id === tFail);
    assert.equal(b.kind, 'failed');
    assert.equal(b.reason, 'Missing theme access');
    assert.ok(f.approvals_waiting.some((a) => a.title === 'Stuck: Build section' && a.type === 'task_failed' && a.priority === 'high'));
    assert.ok(f.agents.length >= 20);
  });

  await step('report_facts: a 7-day window sums every day', async () => {
    const w = await val(`select report_facts('2026-01-12'::date, 7)`);
    assert.equal(Number(w.spend_usd), 9.75);
    assert.equal(w.done.length, 3);
    assert.equal(w.qa.reviews, 3);
    assert.deepEqual(w.qa_by_day.map((d) => [d.date, d.reviews, d.passed]), [['2026-01-15', 2, 1], ['2026-01-16', 1, 1]]);
  });

  await step('save_report is idempotent per (author, date, kind); overwrite updates in place', async () => {
    const a = await val(`select save_report('ea', $1::date, 'daily_digest', '[]', '[]', '[]', 'first', 0.01, '{"headline":"h"}'::jsonb)`, [D]);
    assert.ok(a);
    assert.equal(await val(`select save_report('ea', $1::date, 'daily_digest', '[]', '[]', '[]', 'second', 0, '{}'::jsonb)`, [D]), null);
    assert.equal(await val(`select body_md from reports where id = $1`, [a]), 'first');
    assert.equal(await val(`select save_report('ea', $1::date, 'daily_digest', '[]', '[]', '[]', 'third', 0, '{}'::jsonb, true)`, [D]), a);
    assert.equal(await val(`select body_md from reports where id = $1`, [a]), 'third');
    assert.equal(await val(`select count(*)::int from activity_log where action = 'report.daily_digest'`), 1);
    // standups: one per agent per day
    assert.ok(await val(`select save_report('seo-1', $1::date, 'standup', '["a"]', '[]', '[]', null)`, [D]));
    assert.ok(await val(`select save_report('graphic-1', $1::date, 'standup', '["b"]', '[]', '[]', null)`, [D]));
    assert.equal(await val(`select save_report('seo-1', $1::date, 'standup', '["c"]', '[]', '[]', null)`, [D]), null);
  });

  await step('set_paused toggles settings.paused and logs it', async () => {
    assert.equal(await val(`select set_paused(true, 'telegram')`), true);
    assert.equal(await val(`select value from settings where key = 'paused'`), true);
    assert.equal(await val(`select detail->>'via' from activity_log where action = 'office.paused' order by id desc limit 1`), 'telegram');
    assert.equal(await val(`select set_paused(false, 'telegram')`), false);
    assert.equal(await val(`select value from settings where key = 'paused'`), false);
  });

  await step('the service role (bot) can read facts, save reports and mark Telegram delivery', () => as('service_role', null, async () => {
    assert.ok(await val(`select report_facts(current_date)`));
    const id = await val(`select id from reports where kind = 'daily_digest' and report_date = $1::date`, [D]);
    await db.query(`update reports set telegram_sent_at = now() where id = $1 and telegram_sent_at is null`, [id]);
    assert.ok(await val(`select telegram_sent_at is not null from reports where id = $1`, [id]));
  }));

  await step('anonymous visitors cannot read facts, save reports or pause', () => as('anon', null, async () => {
    await assert.rejects(db.query(`select report_facts(current_date)`), /permission denied/);
    await assert.rejects(db.query(`select save_report('ea', current_date, 'standup', '[]', '[]', '[]', null)`), /permission denied/);
    await assert.rejects(db.query(`select set_paused(true)`), /permission denied/);
  }));

  await step('a non-CEO user cannot use report functions', () => as('authenticated', '22222222-2222-2222-2222-222222222222', async () => {
    await assert.rejects(db.query(`select report_facts(current_date)`), /not allowed/);
  }));
}
