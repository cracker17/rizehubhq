// Costs + handoff (supabase/migrations/20260928100000_costs_handoff.sql): the ai_usage view (per day / agent /
// client / task / model), its RLS, the once-per-day budget alerts, and the design → dev release rule
// (the dev task is queued only after the design task is QA-passed AND the CEO approved it).
export default async function ({ db, step, val, one, status, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const CL = 'c1000000-0000-0000-0000-000000000001';
  const verdict = (pass) => JSON.stringify({
    verdict: pass ? 'pass' : 'fail', score: pass ? 95 : 50, summary: '',
    checks: [{ criterion: 'a', result: pass ? 'pass' : 'fail', note: '' }], fix_list: pass ? [] : ['fix a'],
  });
  let req, design, dev, copy;

  await step('costs: fixture client, request and tasks (design → dev)', async () => {
    await db.exec(`insert into clients (id, name, slug) values ('${CL}', 'Costs Co', 'costs-co')`);
    req = await val(`insert into requests (source, raw_text, status, client_id) values ('dashboard', 'Design + build a page', 'in_progress', '${CL}') returning id`);
    const mk = (agentId, wt, st, deps = '{}') => val(
      `insert into tasks (request_id, client_id, agent_id, title, instructions, work_type, status, depends_on, heartbeat_at, acceptance_criteria)
       values ($1, '${CL}', $2, $2 || ' ' || $3, 'x', $3, $4, $5::uuid[], now(), '["a"]') returning id`, [req, agentId, wt, st, deps]);
    copy = await mk('writer', 'landing-copy', 'working');
    design = await mk('designer', 'ui-mockup', 'working');
    dev = await mk('web-dev', 'shopify-section', 'pending', `{${design}}`);
  });

  await step('costs: record_usage rows show up in ai_usage with provider, model, tokens, client and Manila day', async () => {
    await db.query(`select record_usage('designer', $1, null, 'task', 12000, 3000, 0.0540, '{"provider":"anthropic","model":"claude-haiku-4-5-20251001","cached_in":8000,"cache_write_in":1000}'::jsonb)`, [design]);
    await db.query(`select record_usage('writer', $1, null, 'task', 5000, 1000, 0.0110, '{"provider":"anthropic","model":"claude-haiku-4-5-20251001"}'::jsonb)`, [copy]);
    await db.query(`select record_usage('qa-lead', $1, null, 'qa', 4000, 500, 0.0130, '{"provider":"openai","model":"gpt-5.5"}'::jsonb)`, [design]);
    await db.query(`select record_usage('coo', null, $1, 'plan', 3000, 800, 0.0140, '{"provider":"anthropic","model":"claude-sonnet-5"}'::jsonb)`, [req]);
    // late evening UTC = next morning in Manila
    await db.exec(`update activity_log set created_at = '2026-09-27T17:30:00Z' where action = 'usage.plan' and request_id = '${req}'`);

    const rows = (await db.query(`select agent_id, kind, provider, model, tokens_in, tokens_out, cached_in, cache_write_in, cost_usd::float8 usd, client_id, task_id, usage_day::text as day
                                  from ai_usage where request_id = $1 order by id`, [req])).rows;
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], { agent_id: 'designer', kind: 'task', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', tokens_in: 12000, tokens_out: 3000,
      cached_in: 8000, cache_write_in: 1000, usd: 0.054, client_id: CL, task_id: design, day: rows[0].day });
    assert.equal(rows[2].kind, 'qa');
    assert.equal(rows[3].client_id, CL, 'planning spend is attributed to the request client');
    assert.equal(rows[3].day, '2026-09-28', 'Asia/Manila day');
    assert.equal(rows[1].cached_in, 0, 'missing detail numbers read as 0');
  });

  await step('costs: per task / agent / client / model totals are one query away', async () => {
    assert.equal(Number(await val(`select cost_usd from tasks where id = $1`, [design])), 0.067, 'design task: its run + its QA review');
    assert.equal(Number(await val(`select sum(cost_usd) from ai_usage where client_id = $1`, [CL])), 0.092);
    const byAgent = (await db.query(`select agent_id, sum(cost_usd)::float8 usd from ai_usage where request_id = $1 group by 1 order by 2 desc`, [req])).rows;
    assert.deepEqual(byAgent.map((r) => r.agent_id), ['designer', 'coo', 'qa-lead', 'writer']);
    const byModel = (await db.query(`select model, count(*)::int n from ai_usage where request_id = $1 group by 1 order by 1`, [req])).rows;
    assert.deepEqual(byModel, [{ model: 'claude-haiku-4-5-20251001', n: 2 }, { model: 'claude-sonnet-5', n: 1 }, { model: 'gpt-5.5', n: 1 }]);
  });

  await step('costs: only the CEO can read ai_usage (security_invoker → activity_log RLS)', async () => {
    await as('authenticated', CEO, async () => {
      assert.ok(Number(await val(`select count(*) from ai_usage where request_id = $1`, [req])) === 4);
    });
    await as('authenticated', OTHER, async () => {
      assert.equal(Number(await val(`select count(*) from ai_usage`)), 0);
    });
    await as('anon', null, async () => {
      await assert.rejects(db.query(`select count(*) from ai_usage`), /permission denied/);
    });
  });

  await step('budget alerts: record_budget_alert is once per Manila day and level', async () => {
    assert.equal(await val(`select record_budget_alert('2026-10-05', 80, 8.2, 10)`), true);
    assert.equal(await val(`select record_budget_alert('2026-10-05', 80, 8.9, 10)`), false);
    assert.equal(await val(`select record_budget_alert('2026-10-05', 100, 10.1, 10)`), true);
    assert.equal(Number(await val(`select count(*) from budget_alerts where alert_day = '2026-10-05' and telegram_sent_at is null`)), 2);
  });

  await step('handoff: the dev task waits while the design is working, in QA and awaiting the CEO', async () => {
    await db.query(`select submit_task_output($1, '{"summary":"mockup","content":"# Design spec","files":["design-spec.md"]}'::jsonb)`, [design]);
    await db.query(`select release_ready_tasks($1)`, [req]);
    assert.equal(await status('tasks', dev), 'pending');
    await db.exec(`update tasks set status = 'qa_reviewing' where id = '${design}'`);
    assert.equal(await val(`select record_qa_verdict($1, 'qa-lead', $2::jsonb)`, [design, verdict(true)]), 'pass');
    assert.equal(await status('tasks', design), 'awaiting_ceo');
    await db.query(`select release_ready_tasks($1)`, [req]);
    assert.equal(await status('tasks', dev), 'pending', 'QA pass alone does not release the developer');
  });

  await step('handoff: CEO approves the design → dev task queued, with the spec on the design task output', async () => {
    const deliv = await val(`select id from approvals where task_id = $1 and kind = 'deliverable' and status = 'pending'`, [design]);
    assert.equal(await val(`select decide_approval($1, 'approve')`, [deliv]), 'task_done');
    assert.equal(await status('tasks', design), 'done');
    assert.equal(await status('tasks', dev), 'queued');
    assert.equal(await val(`select d.output ->> 'content' from tasks t join tasks d on d.id = any(t.depends_on) where t.id = $1`, [dev]), '# Design spec');
  });
}
