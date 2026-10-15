// Julev Operator phase 2 (supabase/migrations/20261016000000_operator_worker.sql): a "new task" reply approved on
// Telegram queues a job (Skip does not); /task jobs from the CEO; jobs never run while paused; every outside-world
// action is an approval first and runs only after ✅ (a rejected one resumes the job with the note); finish → QA →
// done / retry / escalated; the client update follows the 'status' tier; memories go to brain_proposals when HQ Brain
// M4 is installed, else wait in operator_memory and are promoted later; login checks notify once per change; the
// credential link needs the CEO; only the service role drives the state machine.
export default async function ({ db, step, val, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const setting = (k, v) => db.query(`insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [k, JSON.stringify(v)]);
  const job = (id) => db.query(`select * from operator_jobs where id = $1`, [id]).then((r) => r.rows[0]);
  const claimJob = () => db.query(`select * from operator_claim_job()`).then((r) => (r.rows[0]?.id ? r.rows[0] : null));
  const claimAction = () => db.query(`select * from operator_claim_action()`).then((r) => (r.rows[0]?.id ? r.rows[0] : null));
  const claimUpdate = () => db.query(`select * from operator_claim_update()`).then((r) => (r.rows[0]?.id ? r.rows[0] : null));
  const decide = (approval, d, note = null) => val(`select decide_approval($1, $2, $3, 'telegram')`, [approval, d, note]);
  const notices = (action) => val(`select count(*)::int from operator_actions where action = $1`, [action]);
  async function asCeo(fn) {
    await db.exec(`set role authenticated`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [CEO, JSON.stringify({ role: 'authenticated', sub: CEO, aal: 'aal2', amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  let channel; let taskInbox; let jobId;

  await step('operator worker: approving a "new task" draft posts the ack AND queues the job; Skip queues nothing', async () => {
    channel = await val(`insert into operator_channels (client_slug, kind, name, url) values ('lvlup', 'google_chat', 'Jobs room', 'https://chat.google.com/room/AAQA-jobs') returning id`);
    const mk = async (id) => {
      const nid = await val(`select operator_ingest($1, $2::jsonb)`, [channel, JSON.stringify({ external_id: id, sender_name: 'Alex', body: `Please update the team page (${id})`, sent_at: '2026-10-16T01:00:00Z' })]);
      const c = (await db.query(`select * from operator_claim_new()`)).rows[0];
      assert.equal(c.id, nid);
      assert.equal(await val(`select operator_record_draft($1, $2::jsonb)`, [nid, JSON.stringify({ category: 'task', action_types: ['task'], confidence: 0.9,
        draft: 'On it, I will update you here.', summary: 'Update the team page', task_plan: ['Open the CMS', 'Edit the bios', 'Publish after approval'] })]), 'approval');
      return nid;
    };
    taskInbox = await mk('t1');
    const skipped = await mk('t2');
    await decide(await val(`select approval_id from operator_inbox where id = $1`, [taskInbox]), 'approve');
    await decide(await val(`select approval_id from operator_inbox where id = $1`, [skipped]), 'reject');
    assert.equal(await val(`select status from operator_inbox where id = $1`, [taskInbox]), 'approved', 'the ack still gets posted');
    assert.equal(await val(`select count(*)::int from operator_jobs where inbox_id = $1`, [skipped]), 0);
    const j = (await db.query(`select * from operator_jobs where inbox_id = $1`, [taskInbox])).rows[0];
    assert.equal(j.status, 'queued');
    assert.equal(j.source, 'chat');
    assert.equal(j.channel_id, channel);
    assert.equal(j.title, 'Update the team page');
    assert.deepEqual(j.plan, ['Open the CMS', 'Edit the bios', 'Publish after approval']);
    assert.match(j.brief, /From Alex/);
    jobId = j.id;
    assert.equal(await notices('job.queued'), 1);
  });

  await step('operator worker: no job runs while the kill switch, the office or the client is paused', async () => {
    await val(`select operator_set_paused(true, 'telegram')`);
    assert.equal(await claimJob(), null);
    await val(`select operator_set_paused(false, 'telegram')`);
    await val(`select operator_set_client_paused('lvlup', true, 'telegram')`);
    assert.equal(await claimJob(), null);
    await val(`select operator_set_client_paused('lvlup', false, 'telegram')`);
    const c = await claimJob();
    assert.equal(c.id, jobId);
    assert.equal(c.status, 'running');
    assert.equal(c.runs, 1);
    assert.equal(await notices('job.started'), 1);
    assert.equal(await claimJob(), null, 'a running job is not claimed twice');
    await val(`select operator_job_step($1, 'browser.open', '{"url":"https://example.com"}'::jsonb)`, [jobId]);
    assert.equal(await val(`select count(*)::int from operator_actions where job_id = $1 and action = 'browser.open'`, [jobId]), 1);
  });

  await step('operator worker: outside-world changes are approvals first; executed only after ✅, re-checked against pauses', async () => {
    const pub = await val(`select operator_request_action($1, 'webflow_publish', 'Publish the LvlUp site to staging', '{"site_id":"abc"}'::jsonb)`, [jobId]);
    const cms = await val(`select operator_request_action($1, 'webflow_cms', 'Update 3 team bios', '{"ops":[]}'::jsonb)`, [jobId]);
    const ap = (await db.query(`select * from approvals where id = $1`, [pub.approval_id])).rows[0];
    assert.equal(ap.kind, 'external_action');
    assert.equal(ap.payload.type, 'operator_action');
    assert.equal(ap.payload.action_kind, 'webflow_publish');
    assert.match(ap.title, /^Publish \(LvlUp Ventures\)/);
    assert.equal(await val(`select approval_is_high_risk(a) from approvals a where id = $1`, [ap.id]), false, 'one tap on Telegram');
    assert.equal(await claimAction(), null, 'nothing runs before a decision');
    // the agent ends its run waiting for the approvals
    assert.equal(await val(`select operator_job_run_done($1, 'waiting', '{}'::jsonb, 0.12)`, [jobId]), 'waiting');
    await decide(pub.approval_id, 'approve');
    await decide(cms.approval_id, 'changes', 'Only Riley\'s bio, not all three');
    assert.equal(await val(`select status from operator_job_actions where id = $1`, [cms.action_id]), 'rejected');
    assert.equal(await val(`select ceo_note from operator_job_actions where id = $1`, [cms.action_id]), 'Only Riley\'s bio, not all three');
    assert.equal((await job(jobId)).status, 'waiting', 'the publish is still open');
    await val(`select operator_set_paused(true, 'telegram')`);
    assert.equal(await claimAction(), null, 'kill switch stops executing');
    await val(`select operator_set_paused(false, 'telegram')`);
    const x = await claimAction();
    assert.equal(x.id, pub.action_id);
    assert.equal(x.status, 'executing');
    assert.equal(await val(`select operator_action_may_run($1)`, [x.id]), null);
    await setting('paused', true);
    assert.equal(await val(`select operator_action_may_run($1)`, [x.id]), 'office paused');
    await setting('paused', false);
    assert.equal(await val(`select operator_action_done($1, true, '{"published":true}'::jsonb)`, [x.id]), 'done');
    assert.equal(await notices('action.done'), 1);
    const j = await job(jobId);
    assert.equal(j.status, 'queued', 'all actions decided → the job runs again to verify');
    assert.equal(Number(j.cost_usd), 0.12);
  });

  await step('operator worker: finish → verifying → QA fail retries with the findings → pass = done', async () => {
    const c = await claimJob();
    assert.equal(c.id, jobId);
    assert.equal(c.runs, 2);
    assert.equal(await val(`select operator_job_run_done($1, 'finished', $2::jsonb, 0.3)`, [jobId,
      JSON.stringify({ summary: 'Updated the team page', links: ['https://lvlup.example/team'], client_update: 'Done: https://lvlup.example/team' })]), 'verifying');
    assert.equal(await val(`select operator_job_verified($1, false, '{"errors":["console: TypeError"]}'::jsonb, 'Fix the console error')`, [jobId]), 'queued');
    assert.equal((await job(jobId)).feedback, 'Fix the console error');
    assert.equal(await notices('job.qa_failed'), 1);
    await claimJob();
    await val(`select operator_job_run_done($1, 'finished', $2::jsonb, 0.1)`, [jobId, JSON.stringify({ summary: 'Fixed', links: ['https://lvlup.example/team'] })]);
    assert.equal(await val(`select operator_job_verified($1, true, '{"errors":[],"evidence":[1,2]}'::jsonb)`, [jobId]), 'done');
    const j = await job(jobId);
    assert.equal(j.status, 'done');
    assert.ok(j.finished_at);
    const done = (await db.query(`select * from operator_actions where action = 'job.done' and job_id = $1`, [jobId])).rows[0];
    assert.deepEqual(done.detail.links, ['https://lvlup.example/team']);
    assert.deepEqual(done.detail.qa.evidence, [1, 2]);
    assert.equal(await val(`select operator_job_verified($1, true)`, [jobId]), 'not_verifying');
  });

  await step('operator worker: runs are limited; errors retry then fail; blocked escalates', async () => {
    const id = await val(`select operator_add_job('lvlup', 'Check the newsletter form', null, 'telegram')`);
    await db.query(`update operator_jobs set max_runs = 2 where id = $1`, [id]);
    await claimJob();
    assert.equal(await val(`select operator_job_run_done($1, 'error', '{}'::jsonb, 0, 'browser crashed')`, [id]), 'queued');
    assert.match((await job(id)).feedback, /browser crashed/);
    await claimJob();
    assert.equal(await val(`select operator_job_run_done($1, 'error', '{}'::jsonb, 0, 'browser crashed')`, [id]), 'failed');
    assert.equal(await notices('job.failed'), 1);
    const b = await val(`select operator_add_job('lvlup', 'Rotate the Airtable key', null, 'telegram')`);
    await claimJob();
    assert.equal(await val(`select operator_job_run_done($1, 'blocked', '{"summary":"needs Julev to log in"}'::jsonb)`, [b]), 'escalated');
    assert.equal((await job(b)).error, 'needs Julev to log in');
    assert.equal(await notices('job.escalated'), 1);
    // QA failing on the last run escalates
    const q = await val(`select operator_add_job('lvlup', 'Fix the hero', null, 'telegram')`);
    await db.query(`update operator_jobs set max_runs = 1 where id = $1`, [q]);
    await claimJob();
    await val(`select operator_job_run_done($1, 'finished', '{"summary":"x"}'::jsonb)`, [q]);
    assert.equal(await val(`select operator_job_verified($1, false, '{}'::jsonb, 'still broken')`, [q]), 'escalated');
    // requests are refused once a job is not running
    await assert.rejects(db.query(`select operator_request_action($1, 'delete', 'Delete the item')`, [q]), /not running/);
  });

  await step('operator worker: the client update follows the status tier; sent through the same pauses', async () => {
    assert.equal(await val(`select operator_queue_update($1, 'Done: the team page is updated https://lvlup.example/team')`, [jobId]), 'approval');
    assert.equal(await val(`select operator_queue_update($1, 'again')`, [jobId]), 'already_queued');
    const o = (await db.query(`select * from operator_outbox where job_id = $1`, [jobId])).rows[0];
    assert.equal(o.status, 'drafted');
    const ap = (await db.query(`select * from approvals where id = $1`, [o.approval_id])).rows[0];
    assert.equal(ap.payload.type, 'operator_update');
    assert.equal(ap.payload.sender, 'Alex');
    await decide(ap.id, 'changes', 'All done, the team page is live: https://lvlup.example/team');
    assert.equal(await val(`select final_text from operator_outbox where id = $1`, [o.id]), 'All done, the team page is live: https://lvlup.example/team');
    await val(`select operator_set_client_paused('lvlup', true, 'telegram')`);
    assert.equal(await claimUpdate(), null);
    await val(`select operator_set_client_paused('lvlup', false, 'telegram')`);
    const c = await claimUpdate();
    assert.equal(c.id, o.id);
    assert.equal(await val(`select operator_update_may_send($1)`, [o.id]), null);
    assert.equal(await val(`select operator_update_done($1, true)`, [o.id]), 'sent');
    const n = (await db.query(`select * from operator_actions where action = 'update.done'`)).rows[0];
    assert.equal(n.job_id, jobId);
    assert.match(n.detail.text, /team page is live/);
    // a CEO job without a chat: no client update; with auto-send + status=auto it goes straight out
    const solo = await val(`select operator_add_job('lvlup', 'Internal check', null)`);
    assert.equal(await val(`select operator_queue_update($1, 'x')`, [solo]), 'no_channel');
    const withChat = await val(`select operator_add_job('lvlup', 'Fix footer', $1)`, [channel]);
    await setting('operator_auto_send', true);
    assert.equal(await val(`select operator_queue_update($1, 'Footer fixed')`, [withChat]), 'auto');
    await setting('operator_auto_send', false);
    await db.query(`insert into operator_autonomy (client_slug, action_type, mode) values ('lvlup', 'status', 'never')`);
    const never = await val(`select operator_add_job('lvlup', 'Fix nav', $1)`, [channel]);
    assert.equal(await val(`select operator_queue_update($1, 'Nav fixed')`, [never]), 'blocked');
    await db.query(`delete from operator_autonomy where client_slug = 'lvlup' and action_type = 'status'`);
    await db.query(`update operator_jobs set status = 'cancelled' where id in ($1, $2, $3)`, [solo, withChat, never]);
    await db.query(`update operator_outbox set status = 'skipped' where status = 'approved'`);
  });

  await step('operator worker: memories wait in operator_memory without HQ Brain M4, then are promoted', async () => {
    await db.query(`insert into brain_projects (slug, name) values ('lvlup-ventures', 'LvlUp Ventures') on conflict do nothing`);
    const m = await val(`select operator_propose_memory($1, 'session_note', 'Updated the team page bios; published to staging.')`, [jobId]);
    assert.ok(m.memory_id);
    assert.equal(m.brain_proposal_id, null);
    const ap = (await db.query(`select * from approvals where id = $1`, [m.approval_id])).rows[0];
    assert.equal(ap.payload.type, 'operator_memory');
    assert.equal(await val(`select approval_is_high_risk(a) from approvals a where id = $1`, [ap.id]), false);
    await decide(ap.id, 'approve');
    assert.equal(await val(`select status from operator_memory where id = $1`, [m.memory_id]), 'approved');
    await assert.rejects(db.query(`select operator_propose_memory($1, 'lesson', 'nope nope')`, [jobId]), /bad kind/);
    assert.equal(await val(`select operator_memory_promote()`), 0, 'no brain_proposals table yet');

    // HQ Brain M4 installed (minimal stand-in for brain_proposals): new proposals go there; waiting ones are promoted.
    await db.exec(`create table brain_proposals (id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
      agent_id text not null, task_id uuid, request_id uuid, approval_id uuid, project_slug text not null, kind text not null, section text,
      text text not null, status text not null default 'pending', ceo_note text, decided_at timestamptz, applied_at timestamptz, applied_sha text, error text)`);
    assert.equal(await val(`select operator_memory_promote()`), 1);
    const promoted = (await db.query(`select * from brain_proposals`)).rows[0];
    assert.equal(promoted.status, 'approved');
    assert.equal(promoted.agent_id, 'operator');
    assert.equal(promoted.project_slug, 'lvlup-ventures');
    assert.equal(await val(`select operator_memory_promote()`), 0, 'once only');
    const d = await val(`select operator_propose_memory($1, 'next_step', 'Ask Riley for the new headshots.')`, [jobId]);
    assert.ok(d.brain_proposal_id);
    const bap = (await db.query(`select * from approvals where id = $1`, [d.approval_id])).rows[0];
    assert.equal(bap.payload.type, 'brain_proposal');
    assert.equal(bap.payload.proposal_id, d.brain_proposal_id);
    assert.equal(await val(`select approval_id from brain_proposals where id = $1`, [d.brain_proposal_id]), d.approval_id);
    await decide(bap.id, 'reject');
    assert.equal(await val(`select status from operator_memory where id = $1`, [d.memory_id]), 'rejected');
    await db.exec(`drop table brain_proposals`);
  });

  await step('operator worker: login checks notify once when lost and once when back', async () => {
    assert.deepEqual((await db.query(`select site from operator_logins where client_slug = 'lvlup' order by site`)).rows.map((r) => r.site), ['airtable', 'google', 'webflow']);
    await val(`select operator_login_checked('lvlup', 'webflow', 'ok')`);
    await val(`select operator_login_checked('lvlup', 'webflow', 'signed_out', 'redirected to /login')`);
    await val(`select operator_login_checked('lvlup', 'webflow', 'signed_out', 'redirected to /login')`);
    assert.equal(await notices('login.lost'), 1);
    await val(`select operator_login_checked('lvlup', 'webflow', 'error', 'timeout')`);
    assert.equal(await notices('login.lost'), 1, 'an error is not a lost login');
    await val(`select operator_login_checked('lvlup', 'webflow', 'signed_out', 'login page')`);
    assert.equal(await notices('login.lost'), 2, 'error → signed out counts again');
    await val(`select operator_login_checked('lvlup', 'webflow', 'ok')`);
    assert.equal(await notices('login.restored'), 1);
    assert.ok(await val(`select last_ok_at from operator_logins where client_slug = 'lvlup' and site = 'webflow'`));
    await assert.rejects(db.query(`select operator_login_checked('lvlup', 'nope', 'ok')`), /unknown login/);
    const s = await val(`select operator_client_status('lvlup')`);
    assert.equal(s.logins.length, 3);
    assert.ok(s.jobs.length >= 1);
    assert.equal(s.client.webflow_credential, undefined, 'credential ids stay out of the status');
  });

  await step('operator worker: evidence is stored and pruned', async () => {
    await db.query(`insert into operator_evidence (job_id, label, url, mime, data) values ($1, 'team 375px', 'https://lvlup.example/team', 'image/jpeg', '\\xffd8ffe0'::bytea)`, [jobId]);
    await db.query(`insert into operator_evidence (job_id, label, mime, data, created_at) values ($1, 'old', 'image/png', '\\x89504e47'::bytea, now() - interval '40 days')`, [jobId]);
    assert.equal(await val(`select operator_evidence_prune(30)`), 1);
    assert.equal(await val(`select count(*)::int from operator_evidence where job_id = $1`, [jobId]), 1);
  });

  await step('operator worker: the CEO adds / cancels jobs and links credentials; nobody else can; the state machine is service-only', async () => {
    const cred = await val(`insert into client_credentials (client_id, platform, label, secret_type, secret_cipher, secret_iv)
      values ((select id from clients order by created_at limit 1), 'webflow', 'LvlUp Webflow token', 'api_token', '\\x00'::bytea, '\\x00'::bytea) returning id`);
    const pw = await val(`insert into client_credentials (client_id, platform, label, secret_type, secret_cipher, secret_iv)
      values ((select id from clients order by created_at limit 1), 'webflow', 'Login', 'password', '\\x00'::bytea, '\\x00'::bytea) returning id`);
    await db.query(`update operator_clients set client_id = null where slug = 'lvlup'`);
    await asCeo(async () => {
      const id = await val(`select operator_add_job('lvlup', 'Audit the blog for broken links', null, 'dashboard')`);
      assert.equal(await val(`select operator_cancel_job($1, 'dashboard')`, [id]), 'cancelled');
      assert.equal(await val(`select operator_cancel_job($1, 'dashboard')`, [id]), 'not_open');
      await assert.rejects(db.query(`select operator_add_job('nope', 'x y z')`), /unknown client/);
      await assert.rejects(db.query(`select operator_add_job('lvlup', 'do it', $1)`, ['00000000-0000-0000-0000-000000000000']), /not one of/);
      await val(`select operator_set_credential('lvlup', 'webflow', $1)`, [cred]);
      await assert.rejects(db.query(`select operator_set_credential('lvlup', 'airtable', $1)`, [cred]), /is for webflow/);
      await assert.rejects(db.query(`select operator_set_credential('lvlup', 'webflow', $1)`, [pw]), /API token/);
      await val(`select operator_set_login_site('lvlup', 'gmail', 'Gmail', 'https://mail.google.com/')`);
      assert.ok(await val(`select count(*)::int from operator_jobs`) > 0, 'the CEO reads jobs');
      await assert.rejects(db.query(`select operator_claim_job()`), /permission denied/);
      await assert.rejects(db.query(`select operator_request_action($1, 'delete', 'x y z')`, [jobId]), /permission denied/);
      await assert.rejects(db.query(`select * from operator_credential('lvlup', 'webflow')`), /permission denied/);
      await assert.rejects(db.query(`insert into operator_jobs (client_slug, source, title, brief) values ('lvlup', 'ceo', 'x', 'xyz')`), /permission denied/);
    });
    assert.equal(await val(`select webflow_credential from operator_clients where slug = 'lvlup'`), cred);
    const got = (await db.query(`select * from operator_credential('lvlup', 'webflow')`)).rows[0];
    assert.equal(got.id, cred);
    assert.equal(await val(`select count(*)::int from credential_access_log where credential_id = $1 and agent_id = 'operator'`, [cred]), 1);
    assert.equal((await db.query(`select * from operator_credential('lvlup', 'airtable')`)).rows.length, 0, 'nothing linked');
    await as('authenticated', OTHER, async () => {
      assert.equal(await val(`select count(*)::int from operator_jobs`), 0);
      await assert.rejects(db.query(`select operator_add_job('lvlup', 'hack the site')`), /not allowed/);
    });
    await as('anon', null, async () => {
      await assert.rejects(db.query(`select operator_add_job('lvlup', 'hack the site')`), /permission denied/);
      await assert.rejects(db.query(`select operator_claim_action()`), /permission denied/);
    });
  });
}
