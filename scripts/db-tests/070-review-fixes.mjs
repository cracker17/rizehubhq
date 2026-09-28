// Review fixes (supabase/migrations/20260928070000_review_fixes.sql): only the pausing approval resumes a task,
// rejected failures cancel + close the request, crash recovery for QA/planning, internal helpers locked down,
// Vault 2FA code handling, per-credential write allowlist, and QA "no verdict" escalation.
export default async function ({ db, step, val, one, status, agent, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const CL = 'c7000000-0000-0000-0000-000000000001';
  const verdict = (pass) => JSON.stringify({
    verdict: pass ? 'pass' : 'fail', score: pass ? 95 : 50, summary: '',
    checks: [{ criterion: 'a', result: pass ? 'pass' : 'fail', note: '' }], fix_list: pass ? [] : ['fix a'],
  });
  const newRequest = (text) => val(`insert into requests (source, raw_text, status, client_id) values ('dashboard', $1, 'in_progress', '${CL}') returning id`, [text]);
  const newTask = (req, agentId, st = 'working', deps = '{}') => val(
    `insert into tasks (request_id, client_id, agent_id, title, instructions, work_type, status, depends_on, heartbeat_at, acceptance_criteria)
     values ($1, '${CL}', $2, $2 || ' task', 'x', 'landing-copy', $3, $4::uuid[], now(), '["a"]') returning id`, [req, agentId, st, deps]);
  const toQaPass = async (t) => {
    await db.query(`select submit_task_output($1, '{"summary":"v1"}'::jsonb)`, [t]);
    await db.exec(`update tasks set status = 'qa_reviewing' where id = '${t}'`);
    return val(`select record_qa_verdict($1, 'qa-lead', $2::jsonb)`, [t, verdict(true)]);
  };

  await step('review fixes: fixture client', () => db.exec(`insert into clients (id, name, slug) values ('${CL}', 'Review Co', 'review-co')`));

  // ---------- 1. only the pausing approval resumes the task ----------
  await step('fix 1: approving a non-pausing external action never re-queues a task waiting on its deliverable', async () => {
    const req = await newRequest('Publish flow');
    const t = await newTask(req, 'wordpress-dev');
    const action = await val(`select request_external_action($1, 'publish', '{"description":"Publish the post"}'::jsonb)`, [t]);
    assert.equal(await status('tasks', t), 'working');
    assert.equal(await val(`select paused_by_approval from tasks where id = $1`, [t]), null);
    assert.equal(await toQaPass(t), 'pass');
    assert.equal(await status('tasks', t), 'awaiting_ceo');
    const deliv = await val(`select id from approvals where task_id = $1 and kind = 'deliverable'`, [t]);
    assert.equal(await val(`select decide_approval($1, 'approve')`, [action]), 'action_approved');
    assert.equal(await status('tasks', t), 'awaiting_ceo', 'still waiting on its own deliverable approval');
    assert.equal(await status('approvals', deliv), 'pending');
    assert.equal(await val(`select decide_approval($1, 'approve')`, [deliv]), 'task_done');
    assert.equal(await status('requests', req), 'done');
  });

  await step('fix 1: pausing functions record their approval; an older question cannot resume a failed task', async () => {
    const req = await newRequest('Question flow');
    const t = await newTask(req, 'webflow-dev');
    const q = await val(`select ask_ceo($1, 'Which CMS collection?', '["A","B"]'::jsonb)`, [t]);
    assert.equal(await val(`select paused_by_approval from tasks where id = $1`, [t]), q);
    assert.equal(await val(`select payload->>'pauses_task' from approvals where id = $1`, [q]), 'true');
    await db.query(`select fail_task($1, 'Site locked')`, [t]);
    const f = await val(`select id from approvals where task_id = $1 and payload->>'type' = 'task_failed'`, [t]);
    assert.equal(await val(`select paused_by_approval from tasks where id = $1`, [t]), f);
    assert.equal(await val(`select decide_approval($1, 'approve', 'Use A')`, [q]), 'action_approved');
    assert.equal(await status('tasks', t), 'failed', 'the stale question does not resume it');
    assert.equal(await val(`select decide_approval($1, 'approve', 'Unlocked, retry')`, [f]), 'action_approved');
    assert.equal(await status('tasks', t), 'queued');
    assert.equal(await val(`select paused_by_approval from tasks where id = $1`, [t]), null);
    assert.equal(await val(`select qa_feedback->>'ceo_note' from tasks where id = $1`, [t]), 'Unlocked, retry');
  });

  await step('fix 1: request_rizehub_action pauses (and resumes) only with p_pause', async () => {
    const req = await newRequest('RizeHub flow');
    const t = await newTask(req, 'client-success');
    const ap = await val(`select request_rizehub_action($1, 'rizehub.invite', '{"description":"Invite"}'::jsonb, true)`, [t]);
    assert.equal(await status('tasks', t), 'awaiting_ceo');
    assert.equal(await val(`select paused_by_approval from tasks where id = $1`, [t]), ap);
    assert.equal(await val(`select decide_approval($1, 'approve')`, [ap]), 'action_approved');
    assert.equal(await status('tasks', t), 'queued');
  });

  // ---------- 2. reject a failure = cancel; request closes after every decision kind ----------
  await step('fix 2: rejecting a task_failed approval cancels the task and closes the request', async () => {
    const req = await newRequest('Doomed');
    const t = await newTask(req, 'social-1');
    await db.query(`select fail_task($1, 'No brand assets')`, [t]);
    const f = await val(`select id from approvals where task_id = $1 and payload->>'type' = 'task_failed'`, [t]);
    assert.equal(await val(`select decide_approval($1, 'reject')`, [f]), 'action_rejected');
    assert.equal(await status('tasks', t), 'cancelled');
    assert.equal(await status('requests', req), 'cancelled');
    assert.equal(await agent('social-1'), 'idle');
  });

  await step('fix 2: a rejected QA escalation closes the request; blocked dependents are cancelled; done work keeps it "done"', async () => {
    const req = await newRequest('Escalation');
    const done = await newTask(req, 'uiux-2', 'done');
    const t = await newTask(req, 'graphic-2');
    const dep = await newTask(req, 'social-2', 'pending', `{${t}}`);
    await db.exec(`update tasks set max_revisions = 0 where id = '${t}'`);
    await db.query(`select submit_task_output($1, '{"summary":"try"}'::jsonb)`, [t]);
    await db.exec(`update tasks set status = 'qa_reviewing' where id = '${t}'`);
    assert.equal(await val(`select record_qa_verdict($1, 'qa-lead', $2::jsonb)`, [t, verdict(false)]), 'escalated');
    const esc = await val(`select paused_by_approval from tasks where id = $1`, [t]);
    assert.equal(await val(`select payload->>'type' from approvals where id = $1`, [esc]), 'qa_escalation');
    assert.equal(await val(`select decide_approval($1, 'reject')`, [esc]), 'action_rejected');
    assert.equal(await status('tasks', t), 'cancelled');
    assert.equal(await status('tasks', dep), 'cancelled', 'can never run: its dependency was cancelled');
    assert.equal(await status('tasks', done), 'done');
    assert.equal(await status('requests', req), 'done');
  });

  // ---------- 3. crash recovery ----------
  await step('fix 3: claims stamp their start; the sweep recovers stalled QA reviews and plans and frees the agents', async () => {
    const req = await newRequest('Stalled review');
    const t = await newTask(req, 'video-editor', 'qa_pending');
    await db.exec(`update tasks set status = 'pending' where status = 'qa_pending' and id <> '${t}'`);
    await db.exec(`update tasks set heartbeat_at = null where id = '${t}'`);
    assert.equal((await one(`select (claim_qa_review()).id`)).id, t);
    assert.ok(await val(`select heartbeat_at > now() - interval '1 minute' from tasks where id = $1`, [t]));
    assert.equal(await agent('qa-lead'), 'working');

    const r = await val(`insert into requests (source, raw_text) values ('dashboard', 'Stalled plan') returning id`);
    await db.exec(`update requests set status = 'failed' where status = 'staged' and id <> '${r}'`);
    assert.equal((await one(`select (claim_request_for_planning()).id`)).id, r);
    assert.ok(await val(`select planning_started_at > now() - interval '1 minute' from requests where id = $1`, [r]));
    assert.equal(await agent('coo'), 'working');

    // a fresh claim is left alone
    assert.equal(await val(`select requeue_stale_tasks()`), 0);
    assert.equal(await status('tasks', t), 'qa_reviewing');
    assert.equal(await status('requests', r), 'planning');

    // the worker died: 11 minutes later
    await db.exec(`update tasks set heartbeat_at = now() - interval '11 minutes' where id = '${t}';
                   update requests set planning_started_at = now() - interval '11 minutes' where status = 'planning';
                   update agents set status = 'working', current_task_id = '${t}' where id = 'sound-engineer';`);
    assert.ok(await val(`select requeue_stale_tasks()`) >= 2);
    assert.equal(await status('tasks', t), 'qa_pending');
    assert.equal(await status('requests', r), 'staged');
    assert.equal(await val(`select planning_started_at from requests where id = $1`, [r]), null);
    assert.equal(await agent('qa-lead'), 'idle');
    assert.equal(await agent('coo'), 'waiting'); // pending planning_failed approvals from earlier suites
    assert.equal(await agent('sound-engineer'), 'idle');
    assert.equal(await val(`select current_task_id from agents where id = 'sound-engineer'`), null);
    assert.equal(await val(`select count(*)::int from activity_log where task_id = $1 and action = 'qa.deferred'`, [t]), 1);
    await db.exec(`update requests set status = 'failed' where id = '${r}'`);
  });

  // ---------- 4. internal helpers are not callable from a browser session ----------
  await step('fix 4: anon and authenticated (even the CEO) cannot call hq_log / refresh_agent_status / finish_agent_turn / guards', async () => {
    const calls = [`select hq_log('ceo','approval.approved',null,null,'{"forged":true}'::jsonb)`, `select refresh_agent_status('seo-1')`,
      `select finish_agent_turn('seo-1')`, `select hq_guard()`, `select hq_can_operate()`];
    for (const [role, uid] of [['anon', null], ['authenticated', OTHER], ['authenticated', CEO]]) {
      await as(role, uid, async () => {
        for (const sql of calls) await assert.rejects(db.query(sql), /permission denied/, `${role} ${uid ?? ''}: ${sql}`);
      });
    }
    await as('service_role', null, async () => {
      assert.equal(await val(`select finish_agent_turn('seo-1')`), 'idle');
      assert.equal(await val(`select hq_can_operate()`), true);
    });
    assert.equal(await val(`select count(*)::int from activity_log where detail->>'forged' = 'true'`), 0);
  });

  await step('fix 4: the CEO still reads through RLS and decides through the workflow RPCs', () => as('authenticated', CEO, async () => {
    assert.ok(await val(`select count(*)::int from agents`) > 0);
    const req = await val(`select create_request('dashboard', 'CEO still works')`);
    assert.ok(req);
    const ap = await val(`select id from approvals where status = 'pending' and kind = 'external_action' and payload->>'type' = 'planning_failed' limit 1`);
    assert.equal(await val(`select decide_approval($1, 'reject')`, [ap]), 'action_rejected');
  }));

  // ---------- 5. vault 2FA ----------
  let cred;
  const hex = (n) => new Uint8Array(n).fill(0xcd);
  await step('fix 5: fixture (credential granted to wordpress-dev)', () => as('service_role', null, async () => {
    cred = await val(`select vault_insert_credential(null, $1, 'wordpress', 'Review WP', 'https://review.example.com/wp-admin', 'hq', 'password',
                      $2::bytea, $3::bytea, 1, 'app', null, '{https://review.example.com/wp-json}', null, 'ceo', '{wordpress-dev}')`, [CL, hex(40), hex(12)]);
  }));
  const ask2fa = async (t) => {
    let id;
    await as('service_role', null, async () => { id = await val(`select vault_request_2fa($1, 'wordpress-dev', $2, 'Reply with the code')`, [cred, t]); });
    return id;
  };
  const noCodeAnywhere = async (code) => {
    assert.equal(await val(`select count(*)::int from activity_log where detail::text like '%' || $1 || '%'`, [code]), 0, 'activity_log');
    assert.equal(await val(`select count(*)::int from approvals where coalesce(ceo_note,'') like '%' || $1 || '%' or payload::text like '%' || $1 || '%'`, [code]), 0, 'approvals');
    assert.equal(await val(`select count(*)::int from tasks where coalesce(qa_feedback::text,'') like '%' || $1 || '%'`, [code]), 0, 'tasks');
  };
  let t2fa;
  await step('fix 5: a typed answer ("changes") is recorded as approve + code, never logged, handed over once, then scrubbed', async () => {
    const req = await newRequest('2FA flow');
    t2fa = await newTask(req, 'wordpress-dev');
    const ap = await ask2fa(t2fa);
    assert.equal(await val(`select paused_by_approval from tasks where id = $1`, [t2fa]), null, '2FA does not pause the task');
    await as('authenticated', CEO, async () => {
      assert.equal(await val(`select decide_approval($1, 'changes', ' 731 904 ', 'telegram')`, [ap]), 'action_approved');
    });
    assert.equal(await status('approvals', ap), 'approved');
    assert.equal(await status('tasks', t2fa), 'working');
    assert.equal(await val(`select count(*)::int from activity_log where detail::text like '%731904%'`), 0, 'never logged');
    assert.equal(await val(`select detail->>'note' from activity_log where action like 'approval.%' and detail->>'approval_id' = $1`, [ap]), '[2FA code]');
    await as('service_role', null, async () => {
      assert.deepEqual(await val(`select vault_take_2fa_code($1)`, [ap]), { status: 'approved', code: '731904' });
      assert.deepEqual(await val(`select vault_take_2fa_code($1)`, [ap]), { status: 'used' });
    });
    await noCodeAnywhere('731904');
  });

  await step('fix 5: approve without a code is refused; reject stores nothing', async () => {
    const ap = await ask2fa(t2fa);
    await assert.rejects(db.query(`select decide_approval($1, 'approve', null, 'telegram')`, [ap]), /one-time code/);
    await assert.rejects(db.query(`select decide_approval($1, 'approve', '   ', 'telegram')`, [ap]), /one-time code/);
    assert.equal(await status('approvals', ap), 'pending');
    assert.equal(await val(`select decide_approval($1, 'reject', '555111', 'telegram')`, [ap]), 'action_rejected');
    assert.equal(await val(`select ceo_note from approvals where id = $1`, [ap]), null);
    await as('service_role', null, async () => {
      assert.deepEqual(await val(`select vault_take_2fa_code($1)`, [ap]), { status: 'rejected' });
    });
    await noCodeAnywhere('555111');
  });

  await step('fix 5: an expired request refuses late answers; a code for a task that stopped is discarded; the sweep scrubs untaken codes', async () => {
    const late = await ask2fa(t2fa);
    await as('service_role', null, () => db.query(`select vault_expire_2fa($1)`, [late]));
    assert.equal(await val(`select decide_approval($1, 'approve', '222333', 'telegram')`, [late]), 'already_rejected');
    await as('service_role', null, async () => {
      assert.deepEqual(await val(`select vault_take_2fa_code($1)`, [late]), { status: 'expired' });
    });

    const untaken = await ask2fa(t2fa);
    assert.equal(await val(`select decide_approval($1, 'approve', '444555')`, [untaken]), 'action_approved');
    assert.equal(await val(`select ceo_note from approvals where id = $1`, [untaken]), '444555'); // the tool may still pick it up
    await db.exec(`update approvals set decided_at = now() - interval '11 minutes' where id = '${untaken}'`);
    await val(`select requeue_stale_tasks()`);
    assert.equal(await val(`select ceo_note from approvals where id = $1`, [untaken]), '[2FA code expired]');
    await as('service_role', null, async () => {
      assert.deepEqual(await val(`select vault_take_2fa_code($1)`, [untaken]), { status: 'no_code' });
    });

    const stopped = await ask2fa(t2fa);
    await db.exec(`update tasks set status = 'queued' where id = '${t2fa}'`);
    assert.equal(await val(`select decide_approval($1, 'approve', '666777')`, [stopped]), 'action_approved');
    assert.equal(await val(`select ceo_note from approvals where id = $1`, [stopped]), '[2FA code discarded]');
    assert.equal(await status('tasks', t2fa), 'queued');
    await noCodeAnywhere('222333');
    await noCodeAnywhere('444555');
    await noCodeAnywhere('666777');
  });

  await step('fix 5: vault_expire_2fa is worker-only', () => as('authenticated', CEO, async () => {
    await assert.rejects(db.query(`select vault_expire_2fa(gen_random_uuid())`), /permission denied/);
  }));

  // ---------- 6. write allowlist ----------
  await step('fix 6: write_allowlist is stored, validated, returned to the worker and readable (not writable) by the CEO', async () => {
    let id;
    await as('service_role', null, async () => {
      id = await val(`select vault_insert_credential(null, $1, 'shopify', 'Review Shopify API', null, null, 'api_token', $2::bytea, $3::bytea, 1,
                      'none', null, '{https://review.myshopify.com/admin/api}', null, 'ceo', '{shopify-dev}',
                      '{"PUT /admin/api/2025-07/themes/123/assets.json"}')`, [CL, hex(40), hex(12)]);
      const row = (await db.query(`select * from vault_get_for_agent($1, 'shopify-dev')`, [id])).rows[0];
      assert.deepEqual(row.write_allowlist, ['PUT /admin/api/2025-07/themes/123/assets.json']);
      const list = await val(`select vault_list_for_agent('shopify-dev', $1)`, [CL]);
      assert.deepEqual(list.granted.find((c) => c.id === id).write_allowlist, ['PUT /admin/api/2025-07/themes/123/assets.json']);
      await assert.rejects(db.query(`select vault_insert_credential(null, $1, 'shopify', 'Bad', null, null, 'api_token', $2::bytea, $3::bytea, 1,
                      'none', null, '{}', null, 'ceo', '{}', '{"DELETE /admin/api/x"}')`, [CL, hex(4), hex(4)]), /write allowlist/);
    });
    assert.deepEqual(await val(`select write_allowlist from client_credentials where id = $1`, [cred]), []);
    await as('authenticated', CEO, async () => {
      assert.deepEqual(await val(`select write_allowlist from client_credentials where id = $1`, [id]), ['PUT /admin/api/2025-07/themes/123/assets.json']);
      // edits without p_write_allowlist keep it; with it, replace it
      await db.query(`select vault_update_credential($1, 'Review Shopify API', null, null, 'none', null, '{https://review.myshopify.com/admin/api}', null)`, [id]);
      assert.equal(await val(`select array_length(write_allowlist, 1) from client_credentials where id = $1`, [id]), 1);
      await db.query(`select vault_update_credential($1, 'Review Shopify API', null, null, 'none', null, '{https://review.myshopify.com/admin/api}', null,
                      null, null, '{"POST /admin/api/2025-07/products.json","PATCH https://review.myshopify.com/admin/api/2025-07/pages"}')`, [id]);
      assert.equal(await val(`select array_length(write_allowlist, 1) from client_credentials where id = $1`, [id]), 2);
      await assert.rejects(db.query(`select vault_update_credential($1, 'x', null, null, 'none', null, '{}', null, null, null, '{"GET /x"}')`, [id]), /write allowlist/);
      await assert.rejects(db.query(`update client_credentials set write_allowlist = '{}' where id = $1`, [id]), /permission denied/);
    });
  });

  // ---------- 7. QA that never produces a verdict ----------
  await step('fix 7: the 3rd QA attempt without a verdict escalates ("qa_stuck"); approve retries QA, reject cancels', async () => {
    const req = await newRequest('QA stuck');
    const t = await newTask(req, 'fullstack-dev', 'qa_reviewing');
    const other = await newTask(req, 'seo-2', 'qa_reviewing');
    assert.equal(await val(`select qa_review_failed($1, 'bad JSON')`, [t]), 'retry');
    assert.equal(await status('tasks', t), 'qa_pending');
    await db.exec(`update tasks set status = 'qa_reviewing' where id = '${t}'`);
    assert.equal(await val(`select qa_review_failed($1, 'bad JSON')`, [t]), 'retry');
    await db.exec(`update tasks set status = 'qa_reviewing' where id = '${t}'`);
    assert.equal(await val(`select qa_review_failed($1, 'bad JSON again')`, [t]), 'escalated');
    assert.equal(await status('tasks', t), 'failed');
    const ap = await val(`select paused_by_approval from tasks where id = $1`, [t]);
    assert.equal(await val(`select payload->>'type' from approvals where id = $1`, [ap]), 'qa_stuck');
    assert.equal(await agent('fullstack-dev'), 'waiting');
    assert.equal(await val(`select qa_review_failed($1, 'x')`, [t]), 'not_under_qa');
    assert.equal(await val(`select decide_approval($1, 'approve')`, [ap]), 'action_approved');
    assert.equal(await status('tasks', t), 'qa_pending');
    assert.equal(await val(`select qa_attempts from tasks where id = $1`, [t]), 0);

    for (let i = 0; i < 3; i++) await val(`select qa_review_failed($1, 'nope')`, [other]).then(() => db.exec(`update tasks set status = 'qa_reviewing' where id = '${other}' and status = 'qa_pending'`));
    const ap2 = await val(`select paused_by_approval from tasks where id = $1`, [other]);
    assert.equal(await val(`select decide_approval($1, 'reject')`, [ap2]), 'action_rejected');
    assert.equal(await status('tasks', other), 'cancelled');
    await as('anon', null, async () => { await assert.rejects(db.query(`select qa_review_failed(gen_random_uuid(), 'x')`), /permission denied/); });
  });

  await step('fix 7: a recorded verdict resets the attempt counter', async () => {
    const req = await newRequest('QA reset');
    const t = await newTask(req, 'fullstack-dev', 'qa_reviewing');
    await val(`select qa_review_failed($1, 'x')`, [t]);
    await db.exec(`update tasks set status = 'qa_reviewing' where id = '${t}'`);
    assert.equal(await val(`select qa_attempts from tasks where id = $1`, [t]), 1);
    assert.equal(await val(`select record_qa_verdict($1, 'qa-lead', $2::jsonb)`, [t, verdict(false)]), 'revision');
    assert.equal(await val(`select qa_attempts from tasks where id = $1`, [t]), 0);
  });
}
