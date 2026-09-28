// Validates migrations + seed + the whole workflow engine + security rules in an in-memory Postgres (PGlite).
// Run from repo root: pnpm db:test
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const db = new PGlite();
const stub = `
create role authenticated nologin; create role anon nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
grant usage on schema auth to authenticated, anon, service_role;
grant execute on all functions in schema auth to authenticated, anon, service_role;
create publication supabase_realtime;
alter default privileges in schema public grant all on tables to authenticated, anon, service_role;
alter default privileges in schema public grant all on sequences to authenticated, anon, service_role;
grant usage on schema public to authenticated, anon, service_role;
`;

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exit(1); }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const val = async (sql, params) => Object.values((await one(sql, params)) ?? {})[0];
const status = (table, id) => val(`select status::text from ${table} where id = $1`, [id]);
const agent = (id) => val(`select status::text from agents where id = $1`, [id]);

const migDir = './supabase/migrations';
await db.exec(stub);
for (const f of fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
  await step(`migration ${f}`, () => db.exec(fs.readFileSync(path.join(migDir, f), 'utf8')));
}
await step('seed', () => db.exec(fs.readFileSync('./supabase/seed.sql', 'utf8')));
await step('22 agents seeded, all idle', async () => {
  assert.equal(await val('select count(*)::int from agents'), 22);
  assert.equal(await val(`select count(*)::int from agents where status <> 'idle'`), 0);
});

const plan = (tasks, title = 'Madam Muse bundle launch') => JSON.stringify({
  title, client_slug: null, summary: 's', assumptions: [], questions_for_ceo: [], due_date: '2026-10-02',
  priority: 'normal', estimated_cost_usd: 0, tasks,
});
const T = (key, agent_id, work_type, depends_on = []) => ({
  key, agent_id, work_type, title: `${key} task`, instructions: 'do it', depends_on,
  acceptance_criteria: ['a', 'b', 'c'],
});
const verdict = (pass, score = pass ? 92 : 60) => JSON.stringify({
  verdict: pass ? 'pass' : 'fail', score, summary: pass ? 'good' : 'needs work',
  checks: [{ criterion: 'a', result: 'pass', note: '' }, { criterion: 'b', result: pass ? 'pass' : 'fail', note: 'x' }],
  fix_list: pass ? [] : ['fix b'],
});

let req, apPlan, copy, wire;
await step('create_request stages a request', async () => {
  req = await val(`select create_request('dashboard', 'Bundle page + copy', 'high', null, null)`);
  assert.equal(await status('requests', req), 'staged');
  assert.equal(await val(`select count(*)::int from activity_log where action = 'request.created'`), 1);
});
await step('empty request is refused', async () => {
  await assert.rejects(db.query(`select create_request('dashboard', '   ')`), /empty/);
});
await step('COO claims it for planning (COO working)', async () => {
  assert.equal((await one(`select (claim_request_for_planning()).id`)).id, req);
  assert.equal(await status('requests', req), 'planning');
  assert.equal(await agent('coo'), 'working');
  assert.equal((await one(`select (claim_request_for_planning()).id`)).id, null);
});
await step('invalid plans are rejected (unknown agent, bad dependency)', async () => {
  await assert.rejects(db.query(`select submit_plan($1, $2::jsonb)`, [req, plan([T('x', 'nobody', 'seo-article')])]), /unknown or disabled agent/);
  await assert.rejects(db.query(`select submit_plan($1, $2::jsonb)`, [req, plan([T('x', 'seo-1', 'seo-article', ['zzz'])])]), /unknown task/);
});
await step('submit_plan → approval pending, COO waiting for CEO', async () => {
  apPlan = await val(`select submit_plan($1, $2::jsonb)`, [req, plan([T('copy', 'seo-1', 'landing-copy'), T('wire', 'uiux-1', 'wireframe', ['copy'])])]);
  assert.equal(await status('requests', req), 'plan_review');
  assert.equal(await status('approvals', apPlan), 'pending');
  assert.equal(await agent('coo'), 'waiting');
});
await step('CEO approves plan → tasks created with dependencies, COO idle', async () => {
  assert.equal(await val(`select decide_approval($1, 'approve', null, 'telegram')`, [apPlan]), 'plan_approved');
  copy = await val(`select id from tasks where request_id = $1 and work_type = 'landing-copy'`, [req]);
  wire = await val(`select id from tasks where request_id = $1 and work_type = 'wireframe'`, [req]);
  assert.equal(await status('tasks', copy), 'queued');
  assert.equal(await status('tasks', wire), 'pending');
  assert.equal(await val(`select depends_on[1] from tasks where id = $1`, [wire]), copy);
  assert.equal(await status('requests', req), 'in_progress');
  assert.equal(await agent('coo'), 'idle');
});
await step('deciding twice is a no-op', async () => {
  assert.equal(await val(`select decide_approval($1, 'reject')`, [apPlan]), 'already_approved');
});
await step('agent claims task, reports progress (POV screen), submits → QA pending', async () => {
  assert.equal((await one(`select (claim_next_task()).id`)).id, copy);
  assert.equal(await agent('seo-1'), 'working');
  await db.query(`select report_progress($1, 40, 'Writing the hero', '{"app":"doc","title":"bundle-copy.md","content":"Build your bundle"}'::jsonb)`, [copy]);
  assert.equal(await val(`select step_note from agent_screens where agent_id = 'seo-1'`), 'Writing the hero');
  await db.query(`select submit_task_output($1, '{"summary":"540 words"}'::jsonb)`, [copy]);
  assert.equal(await status('tasks', copy), 'qa_pending');
  assert.equal(await agent('seo-1'), 'idle');
});
await step('QA fails it → revision with fix list, back in the queue', async () => {
  assert.equal((await one(`select (claim_qa_review()).id`)).id, copy);
  assert.equal(await agent('qa-lead'), 'working');
  assert.equal(await val(`select record_qa_verdict($1, 'qa-lead', $2::jsonb)`, [copy, verdict(false)]), 'revision');
  assert.equal(await status('tasks', copy), 'queued');
  assert.deepEqual(await val(`select qa_feedback->'fix_list' from tasks where id = $1`, [copy]), ['fix b']);
  assert.equal(await agent('qa-lead'), 'idle');
});
await step('a "pass" with a failed check is still a fail', async () => {
  await one(`select (claim_next_task()).id`);
  await db.query(`select submit_task_output($1, '{"summary":"v2"}'::jsonb)`, [copy]);
  await one(`select (claim_qa_review()).id`);
  const sneaky = JSON.stringify({ verdict: 'pass', score: 95, summary: '', checks: [{ criterion: 'a', result: 'fail', note: '' }], fix_list: [] });
  assert.equal(await val(`select record_qa_verdict($1, 'qa-lead', $2::jsonb)`, [copy, sneaky]), 'revision');
});
let apDeliv;
await step('revised work passes QA → deliverable approval, agent waiting', async () => {
  await one(`select (claim_next_task()).id`);
  await db.query(`select submit_task_output($1, '{"summary":"v3","preview_url":"https://example.com/p"}'::jsonb)`, [copy]);
  await one(`select (claim_qa_review()).id`);
  assert.equal(await val(`select record_qa_verdict($1, 'qa-lead', $2::jsonb)`, [copy, verdict(true)]), 'pass');
  assert.equal(await status('tasks', copy), 'awaiting_ceo');
  apDeliv = await val(`select id from approvals where task_id = $1 and kind = 'deliverable'`, [copy]);
  assert.equal(await val(`select preview_url from approvals where id = $1`, [apDeliv]), 'https://example.com/p');
  assert.equal(await agent('seo-1'), 'waiting');
  assert.equal(await val(`select count(*)::int from qa_reviews where task_id = $1`, [copy]), 3);
});
await step('CEO approves deliverable → done, dependent task released', async () => {
  assert.equal(await val(`select decide_approval($1, 'approve')`, [apDeliv]), 'task_done');
  assert.equal(await status('tasks', copy), 'done');
  assert.equal(await status('tasks', wire), 'queued');
  assert.equal(await agent('seo-1'), 'idle');
});
await step('agent asks the CEO a question, answer resumes the task', async () => {
  assert.equal((await one(`select (claim_next_task()).id`)).id, wire);
  const q = await val(`select ask_ceo($1, 'Which hero image?', '["A","B"]'::jsonb)`, [wire]);
  assert.equal(await status('tasks', wire), 'awaiting_ceo');
  assert.equal(await agent('uiux-1'), 'waiting');
  await assert.rejects(db.query(`select decide_approval($1, 'changes', '')`, [q]), /say what should change/);
  assert.equal(await val(`select decide_approval($1, 'approve', 'Use B')`, [q]), 'action_approved');
  assert.equal(await status('tasks', wire), 'queued');
  assert.equal(await val(`select qa_feedback->>'ceo_note' from tasks where id = $1`, [wire]), 'Use B');
});
await step('last task approved → request done', async () => {
  await one(`select (claim_next_task()).id`);
  await db.query(`select submit_task_output($1, '{"summary":"wireframe"}'::jsonb)`, [wire]);
  await one(`select (claim_qa_review()).id`);
  await db.query(`select record_qa_verdict($1, 'qa-lead', $2::jsonb)`, [wire, verdict(true)]);
  const ap = await val(`select id from approvals where task_id = $1 and kind = 'deliverable'`, [wire]);
  await db.query(`select decide_approval($1, 'approve')`, [ap]);
  assert.equal(await status('requests', req), 'done');
  assert.equal(await val(`select count(*)::int from agents where status <> 'idle'`), 0);
});
await step('CEO "changes" on a plan sends it back to the COO with the note', async () => {
  const r2 = await val(`select create_request('telegram', 'Blog post')`);
  await one(`select (claim_request_for_planning()).id`);
  const ap = await val(`select submit_plan($1, $2::jsonb)`, [r2, plan([T('post', 'seo-2', 'seo-article')], 'Blog')]);
  assert.equal(await val(`select decide_approval($1, 'changes', 'Make it 1,500 words')`, [ap]), 'replan');
  assert.equal(await status('requests', r2), 'staged');
  assert.deepEqual(await val(`select brief->'ceo_feedback' from requests where id = $1`, [r2]), ['Make it 1,500 words']);
});
await step('QA failing past max revisions escalates to the CEO; agent waits for the CEO', async () => {
  const r3 = await val(`select create_request('dashboard', 'Hard task')`);
  await one(`select (claim_request_for_planning()).id`);
  const ap = await val(`select submit_plan($1, $2::jsonb)`, [r3, plan([T('hard', 'graphic-1', 'ad-creative')], 'Ads')]);
  await db.query(`select decide_approval($1, 'approve')`, [ap]);
  // replan request r2 is still staged, so claim_next_task only sees graphic-1's task
  const t = await val(`select id from tasks where request_id = $1`, [r3]);
  let res;
  for (let i = 0; i < 4; i++) {
    await one(`select (claim_next_task()).id`);
    await db.query(`select submit_task_output($1, '{"summary":"try"}'::jsonb)`, [t]);
    await one(`select (claim_qa_review()).id`);
    res = await val(`select record_qa_verdict($1, 'qa-lead', $2::jsonb)`, [t, verdict(false)]);
  }
  assert.equal(res, 'escalated');
  assert.equal(await status('tasks', t), 'failed');
  assert.equal(await agent('graphic-1'), 'waiting'); // has a pending escalation approval
  const esc = await val(`select id from approvals where task_id = $1 and payload->>'type' = 'qa_escalation'`, [t]);
  assert.equal(await val(`select decide_approval($1, 'approve', 'Try a darker background')`, [esc]), 'action_approved');
  assert.equal(await status('tasks', t), 'queued');
});
await step('fail_task creates a "stuck" approval', async () => {
  const t = await val(`select id from tasks where agent_id = 'graphic-1' and status = 'queued'`);
  await one(`select (claim_next_task()).id`);
  await db.query(`select fail_task($1, 'Missing brand fonts')`, [t]);
  assert.equal(await status('tasks', t), 'failed');
  assert.equal(await val(`select count(*)::int from approvals where task_id = $1 and payload->>'type' = 'task_failed'`, [t]), 1);
});
await step('stale working tasks are re-queued', async () => {
  await db.exec(`update tasks set status='working', heartbeat_at = now() - interval '20 minutes' where agent_id = 'graphic-1'`);
  assert.equal(await val(`select requeue_stale_tasks()`), 1);
});

// ---------- security ----------
await db.exec(`insert into auth.users (id,email) values ('11111111-1111-1111-1111-111111111111','ceo@x.com'),('22222222-2222-2222-2222-222222222222','other@x.com');
               insert into ceo_users (user_id) values ('11111111-1111-1111-1111-111111111111');`);
async function as(role, uid, fn) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub','${uid ?? ''}',false);
                 select set_config('request.jwt.claims','${uid ? JSON.stringify({ sub: uid, role }) : JSON.stringify({ role })}',false);`);
  try { await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`); }
}
await step('a non-CEO user sees nothing and cannot act', () => as('authenticated', '22222222-2222-2222-2222-222222222222', async () => {
  assert.equal(await val('select count(*)::int from agents'), 0);
  await assert.rejects(db.query(`select create_request('dashboard','hack')`), /not allowed/);
}));
await step('anonymous visitors cannot call workflow functions', () => as('anon', null, async () => {
  await assert.rejects(db.query(`select create_request('dashboard','hack')`), /permission denied/);
}));
await step('the CEO sees the office and can create requests', () => as('authenticated', '11111111-1111-1111-1111-111111111111', async () => {
  assert.equal(await val('select count(*)::int from agents'), 22);
  assert.ok(await val(`select create_request('dashboard','From the CEO')`));
}));
await step('nobody in the browser can read vault secrets', () => as('authenticated', '11111111-1111-1111-1111-111111111111', async () => {
  await assert.rejects(db.query('select secret_cipher from client_credentials'), /permission denied/);
  assert.equal(await val('select count(*)::int from client_credentials'), 0); // metadata columns still readable
}));
await step('the service role (worker) can operate', () => as('service_role', null, async () => {
  assert.ok((await one(`select (claim_request_for_planning()).id`)).id);
}));

// ---------- worker helpers (20260928020000_worker_helpers.sql) ----------
await step('planning_failed → request failed + "COO couldn\'t plan this" approval', async () => {
  const r = await val(`select id from requests where status = 'planning' order by created_at limit 1`);
  assert.ok(r);
  const ap = await val(`select planning_failed($1, 'plan kept using unknown agents')`, [r]);
  assert.equal(await status('requests', r), 'failed');
  assert.equal(await val(`select payload->>'type' from approvals where id = $1`, [ap]), 'planning_failed');
  assert.match(await val(`select title from approvals where id = $1`, [ap]), /^COO couldn't plan this: plan kept/);
  assert.equal(await agent('coo'), 'waiting');
  await assert.rejects(db.query(`select planning_failed($1, 'again')`, [r]), /not being planned/);
});
await step('release_request_for_planning hands a claimed request back to the queue', async () => {
  await val(`select create_request('telegram', 'Release me', 'urgent')`);
  const r = (await one(`select (claim_request_for_planning()).id`)).id;
  assert.equal(await status('requests', r), 'planning');
  await db.query(`select release_request_for_planning($1, 'no model quota')`, [r]);
  assert.equal(await status('requests', r), 'staged');
});
let helperTask;
await step('requeue_task puts a working task back without failing it; heartbeat touch works', async () => {
  const r = await val(`select create_request('dashboard', 'Helper test')`);
  await db.exec(`update requests set status = 'planning' where id = '${r}'`);
  const ap = await val(`select submit_plan($1, $2::jsonb)`, [r, plan([T('h', 'seo-2', 'seo-article')], 'Helper')]);
  await db.query(`select decide_approval($1, 'approve')`, [ap]);
  helperTask = await val(`select id from tasks where request_id = $1`, [r]);
  await db.exec(`update tasks set status = 'pending' where status = 'queued' and id <> '${helperTask}'`);
  assert.equal((await one(`select (claim_next_task()).id`)).id, helperTask);
  await db.exec(`update tasks set heartbeat_at = now() - interval '5 minutes' where id = '${helperTask}'`);
  await db.query(`select touch_task_heartbeat($1)`, [helperTask]);
  assert.ok(await val(`select heartbeat_at > now() - interval '1 minute' from tasks where id = $1`, [helperTask]));
  await db.query(`select requeue_task($1, 'quota')`, [helperTask]);
  assert.equal(await status('tasks', helperTask), 'queued');
  assert.equal(await agent('seo-2'), 'idle');
  assert.equal(await val(`select count(*)::int from activity_log where action = 'task.requeued' and task_id = $1`, [helperTask]), 1);
});
await step('request_external_action queues an approval and leaves the task running', async () => {
  await one(`select (claim_next_task()).id`);
  const ap = await val(`select request_external_action($1, 'publish', '{"description":"Publish article on the blog"}'::jsonb)`, [helperTask]);
  assert.equal(await status('approvals', ap), 'pending');
  assert.equal(await val(`select payload->>'action_type' from approvals where id = $1`, [ap]), 'publish');
  assert.equal(await status('tasks', helperTask), 'working');
});
await step('record_usage logs tokens + cost and adds them to the task and request', async () => {
  await db.query(`select record_usage('seo-2', $1, null, 'task', 1200, 300, 0.0123, '{"provider":"anthropic"}'::jsonb)`, [helperTask]);
  await db.query(`select record_usage('seo-2', $1, null, 'task', 100, 50, 0.001, '{}'::jsonb)`, [helperTask]);
  assert.equal(await val(`select tokens_in from tasks where id = $1`, [helperTask]), 1300);
  assert.equal(Number(await val(`select cost_usd from tasks where id = $1`, [helperTask])), 0.0133);
  assert.equal(Number(await val(`select r.cost_usd from requests r join tasks t on t.request_id = r.id where t.id = $1`, [helperTask])), 0.0133);
  assert.equal(await val(`select detail->>'provider' from activity_log where action = 'usage.task' order by id limit 1`), 'anthropic');
});
await step('release_qa_review hands a review back to qa_pending', async () => {
  await db.query(`select submit_task_output($1, '{"summary":"article"}'::jsonb)`, [helperTask]);
  assert.equal((await one(`select (claim_qa_review()).id`)).id, helperTask);
  await db.query(`select release_qa_review($1, 'quota')`, [helperTask]);
  assert.equal(await status('tasks', helperTask), 'qa_pending');
  assert.equal(await agent('qa-lead'), 'idle');
});
await step('set_idle_activity only moves idle agents; update_agent_screen upserts the POV row', async () => {
  assert.equal(await val(`select set_idle_activity('seo-1', 'coffee')`), true);
  assert.equal(await val(`select idle_activity from agents where id = 'seo-1'`), 'coffee');
  await db.exec(`update agents set status = 'working' where id = 'seo-1'`);
  assert.equal(await val(`select set_idle_activity('seo-1', 'lobby')`), false);
  await db.exec(`update agents set status = 'idle' where id = 'seo-1'`);
  await db.query(`select update_agent_screen('qa-lead', $1, '{"app":"review","title":"QA","step_note":"Checking","progress":40}'::jsonb)`, [helperTask]);
  assert.equal(await val(`select progress from agent_screens where agent_id = 'qa-lead'`), 40);
});
await step('anonymous visitors cannot call worker helpers', () => as('anon', null, async () => {
  await assert.rejects(db.query(`select requeue_task(gen_random_uuid(), 'x')`), /permission denied/);
}));

console.log(`\nAll ${passed} database checks passed.`);

// ---------- extra suites (scripts/db-tests/*.mjs, run in name order) ----------
// Each suite: export default async function ({ db, step, one, val, status, agent, as, assert }) { ... }
const extraDir = './scripts/db-tests';
if (fs.existsSync(extraDir)) {
  for (const f of fs.readdirSync(extraDir).filter((f) => f.endsWith('.mjs')).sort()) {
    const mod = await import(path.resolve(extraDir, f));
    await mod.default({ db, step, one, val, status, agent, as, assert });
  }
  console.log(`All ${passed} database checks passed (incl. extra suites).`);
}
