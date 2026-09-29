// Security hardening (supabase/migrations/20260929030000_security_hardening.sql): every public function has a fixed
// search_path; the anon role can execute no function at all; worker/bot-only and trigger functions are service-role
// only; the CEO keeps the dashboard RPCs (and RLS via is_ceo()); the service role keeps everything.
// These checks enumerate pg_proc, so a FUTURE migration that forgets its revoke/grant block fails here.
export default async function ({ db, step, val, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const nowSec = () => Math.floor(Date.now() / 1000);
  // Any JWT shape (aal2 + fresh TOTP works whether or not an earlier suite left the CEO with a TOTP factor).
  async function asJwt(role, claims, fn) {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [claims.sub ?? '', JSON.stringify({ role, ...claims })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  const ceoJwt = { sub: CEO, aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - 5 }] };

  // Public, non-extension functions (what the Supabase advisor looks at).
  const OURS = `from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.prokind in ('f', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`;
  const sigs = async (where) => (await db.query(`select p.oid::regprocedure::text as sig ${OURS} and ${where} order by 1`)).rows.map((r) => r.sig);

  // group A of the migration: the CEO's API (dashboard server actions + RLS)
  const CEO_API = [
    'is_ceo()', 'ceo_step_up_status()', 'create_request(text,text,text,date,text)', 'decide_approval(uuid,text,text,text)',
    'report_facts(date,integer)', 'create_access_request(uuid,text[],text,integer,text)', 'vault_cancel_access_request(uuid)',
    'vault_revoke(uuid,text)', 'vault_set_grants(uuid,text[])', 'vault_grant(uuid,text)', 'vault_revoke_grant(uuid,text)',
    'vault_update_credential(uuid,text,text,text,text,text,text[],timestamp with time zone,text,text,text[])',
    'connector_set_grants(uuid,text[])', 'connector_update(uuid,text,jsonb)', 'connector_set_status(uuid,text)',
    'connector_delete(uuid)', 'save_auto_approve_rule(jsonb)', 'delete_auto_approve_rule(uuid)',
    'mark_job_applied(uuid,integer)', 'set_job_status(uuid,text,timestamp with time zone,text)',
    'sales_move_stage(uuid,lead_stage,text,text)', 'storage_set_default(uuid)',
  ];
  // groups B + C: worker / bot only, and trigger functions
  const SERVICE_ONLY = [
    'claim_request_for_planning()', 'release_request_for_planning(uuid,text)', 'submit_plan(uuid,jsonb)',
    'planning_failed(uuid,text)', 'claim_next_task()', 'release_ready_tasks(uuid)', 'claim_qa_review()',
    'release_qa_review(uuid,text)', 'record_qa_verdict(uuid,text,jsonb,integer)', 'submit_task_output(uuid,jsonb)',
    'report_progress(uuid,integer,text,jsonb)', 'touch_task_heartbeat(uuid)', 'requeue_task(uuid,text)',
    'requeue_stale_tasks()', 'fail_task(uuid,text)', 'ask_ceo(uuid,text,jsonb)', 'request_external_action(uuid,text,jsonb)',
    'external_action_exec(uuid,text,jsonb)', 'record_usage(text,uuid,uuid,text,integer,integer,numeric,jsonb)',
    'set_idle_activity(text,text)', 'update_agent_screen(text,uuid,jsonb)',
    'save_report(text,date,text,jsonb,jsonb,jsonb,text,numeric,jsonb,boolean)', 'set_paused(boolean,text)',
    'store_webhook_event(text,text,jsonb,boolean)', 'process_rizehub_event(uuid)', 'rizehub_open_request(text)',
    'record_rizehub_ref(uuid,text,text,jsonb,uuid)', 'request_rizehub_action(uuid,text,jsonb,boolean)',
    'rizehub_job_finished(text,text,jsonb)', 'park_task_for_job(uuid,text,jsonb)', 'upsert_job_opportunity(jsonb,uuid)',
    'queue_job_follow_ups()', 'sales_create_daily_batch(date,boolean,integer)', 'sales_decide_batch(uuid,jsonb,text,text,text)',
    'sales_suppress(text,text,text,uuid)', 'sales_client_slug(text)', 'sales_is_suppressed(text)', 'sales_request_open(uuid)',
    'storage_default_connector()', 'task_record_storage(uuid,jsonb)',
    'touch_updated_at()', 'sales_suppression_permanent()', 'sales_lead_emails_guard()', 'sales_on_approval_decided()',
  ];

  await step('hardening: every public (non-extension) function has a fixed search_path', async () => {
    const missing = await sigs(`not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')`);
    assert.deepEqual(missing, [], `functions without search_path: ${missing.join(', ')}`);
    assert.equal(await val(`select array_to_string(proconfig, ',') from pg_proc where oid = 'hq_guard()'::regprocedure`), 'search_path=public');
  });

  await step('hardening: the anon role can execute no public function (and nothing is left to PUBLIC)', async () => {
    const anon = await sigs(`has_function_privilege('anon', p.oid, 'execute')`);
    assert.deepEqual(anon, [], `anon can execute: ${anon.join(', ')}`);
    const pub = await sigs(`exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                    where a.grantee = 0 and a.privilege_type = 'EXECUTE')`);
    assert.deepEqual(pub, [], `PUBLIC can execute: ${pub.join(', ')}`);
  });

  await step('hardening: anon calls to the 6 advisor findings are refused', () => as('anon', null, async () => {
    for (const sql of [`select is_ceo()`, `select sales_client_slug('Biz')`, `select sales_is_suppressed('a@b.com')`,
      `select sales_request_open(gen_random_uuid())`, `select sales_lead_emails_guard()`, `select sales_on_approval_decided()`]) {
      await assert.rejects(db.query(sql), /permission denied/, sql);
    }
  }));

  await step('hardening: worker/bot-only and trigger functions are not executable by signed-in users', async () => {
    const leaked = [];
    for (const f of SERVICE_ONLY) {
      if (await val(`select has_function_privilege('authenticated', $1::regprocedure, 'execute')`, [f])) leaked.push(f);
      assert.equal(await val(`select has_function_privilege('service_role', $1::regprocedure, 'execute')`, [f]), true, `service_role: ${f}`);
    }
    assert.deepEqual(leaked, []);
    for (const [uid, claims] of [[OTHER, { sub: OTHER }], [CEO, ceoJwt]]) {
      await asJwt('authenticated', claims, async () => {
        for (const sql of [`select claim_next_task()`, `select submit_plan(gen_random_uuid(), '{}'::jsonb)`,
          `select store_webhook_event('e', 'x.y', '{}'::jsonb, true)`, `select set_paused(true, 'dashboard')`,
          `select sales_decide_batch(gen_random_uuid())`, `select record_usage('coo', null, null, 'task', 1, 1, 1, '{}'::jsonb)`]) {
          await assert.rejects(db.query(sql), /permission denied/, `${uid}: ${sql}`);
        }
      });
    }
  });

  await step('hardening: the CEO API stays executable by authenticated + service_role, not anon', async () => {
    for (const f of CEO_API) {
      assert.deepEqual(await val(`select array[has_function_privilege('authenticated', $1::regprocedure, 'execute'),
                                               has_function_privilege('service_role', $1::regprocedure, 'execute'),
                                               has_function_privilege('anon', $1::regprocedure, 'execute')]`, [f]), [true, true, false], f);
    }
  });

  await step('hardening: the CEO still reads through RLS, calls the dashboard RPCs, and triggers still fire', async () => {
    const r = await val(`insert into requests (source, raw_text, status) values ('dashboard', 'hardening', 'planning') returning id`);
    let ap;
    await asJwt('service_role', { role: 'service_role' }, async () => { ap = await val(`select planning_failed($1, 'hardening check')`, [r]); });
    await db.exec(`update agents set updated_at = '2020-01-01' where id = 'coo'`);
    await asJwt('authenticated', ceoJwt, async () => {
      assert.equal(await val(`select is_ceo()`), true);
      assert.equal(await val(`select count(*)::int from agents`), 6, 'RLS (is_ceo) still lets the CEO read');
      assert.equal(typeof (await val(`select ceo_step_up_status()`)), 'object');
      assert.ok(await val(`select create_request('dashboard', 'Hardening: CEO still works')`));
      assert.equal(await val(`select decide_approval($1, 'reject', 'no', 'dashboard')`, [ap]), 'action_rejected');
      assert.ok(await val(`select report_facts(current_date)`));
      // touch_updated_at() fires for the CEO although authenticated no longer has EXECUTE on it
      await db.query(`update agents set updated_at = updated_at where id = 'coo'`);
    });
    assert.ok(await val(`select updated_at > now() - interval '1 minute' from agents where id = 'coo'`));
    await asJwt('authenticated', { sub: OTHER }, async () => {
      assert.equal(await val(`select is_ceo()`), false);
      await assert.rejects(db.query(`select create_request('dashboard', 'hack')`), /not allowed/);
    });
  });

  await step('hardening: the service role (worker, bot) still runs worker and CEO functions', async () => {
    const denied = await sigs(`not has_function_privilege('service_role', p.oid, 'execute')`);
    assert.deepEqual(denied, [], `service_role cannot execute: ${denied.join(', ')}`);
    await asJwt('service_role', { role: 'service_role' }, async () => {
      assert.equal(await val(`select sales_is_suppressed('nobody@example.com')`), false);
      assert.equal(await val(`select sales_client_slug('Hardening Co')`) !== null, true);
      assert.equal(typeof (await val(`select requeue_stale_tasks()`)), 'number');
      assert.equal(await val(`select set_paused(false, 'telegram')`), false);
    });
  });
}
