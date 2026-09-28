// End-to-end lifecycle against real PostgREST (started by scripts/integration/run.mjs).
// Uses the apps' own modules; only the model (MockLanguageModelV2), Telegram (a recording Sender) and
// GoTrue (auth.getUser answered from the JWT we minted) are stand-ins.
//
//   dashboard (CEO JWT, RLS applies) : real server actions + loaders via @/lib/supabase/server stand-in
//   worker    (service role)         : createSupabaseHqDb + WorkerLoop.tick → planner → runner → QA
//   bot       (service role)         : createSupabaseBotDb + notifierTick + onButton/onNoteText
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const W = path.join(ROOT, 'apps/worker');
const B = path.join(ROOT, 'apps/bot');
const D = path.join(ROOT, 'apps/dashboard');
const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} missing: run via scripts/integration/run.mjs`); return v; };
const URL_ = env('IT_SUPABASE_URL');
const ANON = env('IT_ANON_KEY');
const SERVICE = env('IT_SERVICE_KEY');
const CEO_JWT = env('IT_CEO_JWT');
const OTHER_JWT = env('IT_OTHER_JWT');
const CEO = { id: '11111111-1111-4111-8111-111111111111', email: 'ceo@rizehub.test' };
const OTHER = { id: '22222222-2222-4222-8222-222222222222', email: 'intern@rizehub.test' };

// ---------- module wiring ----------
const wreq = createRequire(path.join(W, 'package.json'));
const dreq = createRequire(path.join(D, 'package.json'));
const { createClient } = wreq('@supabase/supabase-js') as typeof import('@supabase/supabase-js');
type SB = ReturnType<typeof createClient>;

/** A user's session client, like @supabase/ssr's createServerClient with the auth cookie (anon key + user JWT). */
function sessionClient(jwt: string, user: { id: string; email: string } | null): SB {
  const c = createClient(URL_, ANON, { accessToken: async () => jwt });
  const auth = { getUser: async () => ({ data: { user }, error: null }), signOut: async () => ({ error: null }) };
  return new Proxy(c, { get: (t, p, r) => (p === 'auth' ? auth : Reflect.get(t, p, r)) }) as SB;
}
const service = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const ceo = sessionClient(CEO_JWT, CEO);
const other = sessionClient(OTHER_JWT, OTHER);
const anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

// Dashboard modules are CJS under tsx: stub `server-only` and route createSupabaseServer() to the current session.
let session: SB | null = ceo;
const fakeModule = (file: string, exports: object) => { (dreq.cache as Record<string, unknown>)[file] = { id: file, filename: file, loaded: true, exports }; };
fakeModule(dreq.resolve('server-only'), {});
fakeModule(path.join(D, 'src/lib/supabase/server.ts'), { createSupabaseServer: async () => session });
process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
delete process.env.HQ_WORKER_URL;

const loaders = await import(path.join(D, 'src/lib/data/loaders.ts'));
const actions = await import(path.join(D, 'src/app/actions.ts'));
const dashVault = await import(path.join(D, 'src/lib/data/vault.ts'));
const dashReports = await import(path.join(D, 'src/lib/data/reports.ts'));

const { createSupabaseHqDb } = await import(path.join(W, 'src/hqdb.ts'));
const { WorkerLoop } = await import(path.join(W, 'src/loop.ts'));
const { createBrain } = await import(path.join(W, 'src/brain.ts'));
const { loadRole } = await import(path.join(W, 'src/roles.ts'));
const { config } = await import(path.join(W, 'src/config.ts'));
const { costUsd } = await import(path.join(W, 'src/models/usage.ts'));
const { runReportJob } = await import(path.join(W, 'src/reportsJob.ts'));
const { manilaToday } = await import(path.join(W, 'src/deps.ts'));
const { mockModel, jsonResponse, toolCalls, promptText } = await import(path.join(W, 'src/testing.ts'));
const { MockLanguageModelV2 } = wreq('ai/test') as typeof import('ai/test');

const { createSupabaseBotDb } = await import(path.join(B, 'src/db.ts'));
const { notifierTick } = await import(path.join(B, 'src/notifier.ts'));
const { onButton, onNoteText } = await import(path.join(B, 'src/decisions.ts'));
const { PendingNotes } = await import(path.join(B, 'src/pending.ts'));

// ---------- tiny test runner ----------
let passed = 0;
const failures: string[] = [];
const known: string[] = [];
/** `knownIssue`: a documented, not-yet-fixed bug. Its failure is printed loudly but does not fail the run. */
async function step(name: string, fn: () => Promise<void>, { critical = true, knownIssue = '' } = {}) {
  try {
    await fn(); passed++;
    console.log(`✓ ${name}${knownIssue ? `\n  (known issue "${knownIssue}" looks fixed: drop the knownIssue flag in lifecycle.mts)` : ''}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (knownIssue) {
      known.push(`${knownIssue}: ${msg.split('\n')[0]}`);
      console.warn(`⚠ KNOWN ISSUE ${name}\n  ${knownIssue}\n  ${msg.split('\n').join('\n  ')}`);
      return;
    }
    failures.push(`${name}: ${msg}`);
    console.error(`✗ ${name}\n  ${msg.split('\n').join('\n  ')}`);
    if (critical) { report(); process.exit(1); }
  }
}
function report() {
  console.log(`\n${passed} integration checks passed${failures.length ? `, ${failures.length} failed` : ''}${known.length ? `, ${known.length} known issue(s)` : ''}.`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  for (const k of known) console.log(`  ⚠ ${k}`);
}
async function q<T = any>(p: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>, what = 'query'): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}${error.code ? ` (${error.code})` : ''}`);
  return data as T;
}
const svc = {
  request: (id: string) => q(service.from('requests').select('*').eq('id', id).single()),
  task: (id: string) => q(service.from('tasks').select('*').eq('id', id).single()),
  agentStatus: async (id: string) => (await q(service.from('agents').select('status').eq('id', id).single())).status as string,
  approvals: (filter: Record<string, string>) => {
    let b = service.from('approvals').select('*');
    for (const [k, v] of Object.entries(filter)) b = b.eq(k, v);
    return q<any[]>(b.order('created_at'));
  },
};

// ---------- scripted models ----------
const CRITERIA = ['Headline names the bundle offer', 'CTA above the fold', 'Mobile layout described for 375px'];
const PLAN = {
  title: 'Madam Muse bundle launch', client_slug: 'madam-muse', summary: 'Landing copy, then a wireframe that uses it.',
  assumptions: ['Shopify store'], questions_for_ceo: [], due_date: '2026-10-02', priority: 'high', estimated_cost_usd: 1.2,
  tasks: [
    { key: 'copy', agent_id: 'seo-1', work_type: 'landing-copy', title: 'Bundle landing copy', instructions: 'Write the bundle page copy.', acceptance_criteria: CRITERIA, depends_on: [] },
    { key: 'wire', agent_id: 'uiux-1', work_type: 'wireframe', title: 'Bundle page wireframe', instructions: 'Wireframe the bundle page using the copy.', acceptance_criteria: CRITERIA, depends_on: ['copy'] },
  ],
};
const BAD_PLAN = { ...PLAN, title: 'Broken', tasks: [{ ...PLAN.tasks[0], agent_id: 'nobody' }] };
const plannerModel = mockModel([jsonResponse(PLAN), jsonResponse(BAD_PLAN), jsonResponse(BAD_PLAN)]);

const runnerPrompts: { taskId: string; text: string }[] = [];
const runnerModel = new MockLanguageModelV2({
  doGenerate: async (opts) => {
    const text = promptText(opts);
    const taskId = /Task id: ([0-9a-f-]{36})/.exec(text)?.[1] ?? '?';
    const title = /# Task: (.+?)(?:\\n|\n)/.exec(text)?.[1] ?? 'task';
    if (!opts.prompt.some((m) => m.role === 'tool')) {
      runnerPrompts.push({ taskId, text });
      return toolCalls([{ name: 'report_progress', input: { percent: 50, note: `Drafting ${title}`, app: 'doc', title: `${title}.md`, content: `# ${title}\nDraft…` } }], { inputTokens: 900, outputTokens: 120 });
    }
    const attempt = runnerPrompts.filter((p) => p.taskId === taskId).length;
    return toolCalls([{ name: 'submit_output', input: {
      summary: `${title} v${attempt}`, content: `# ${title}\nFinal copy v${attempt}`, files: [],
      criteria_map: CRITERIA.map((c) => ({ criterion: c, how_met: 'See section 1' })),
    } }], { inputTokens: 1100, outputTokens: 400 });
  },
});

let qaCalls = 0;
const qaModel = new MockLanguageModelV2({
  doGenerate: async () => {
    qaCalls++;
    const fail = qaCalls === 1; // the very first review fails once, everything after passes
    return jsonResponse({
      verdict: fail ? 'fail' : 'pass', score: fail ? 62 : 93, summary: fail ? 'CTA is below the fold' : 'Meets every criterion',
      checks: CRITERIA.map((criterion, i) => ({ criterion, result: fail && i === 1 ? 'fail' : 'pass', note: fail && i === 1 ? 'CTA sits under the hero image' : 'ok' })),
      fix_list: fail ? ['Move the CTA above the fold'] : [],
    }, { inputTokens: 700, outputTokens: 150 });
  },
});

// ---------- worker ----------
const hqdb = createSupabaseHqDb(service);
const workerLogs: string[] = [];
const models: Record<string, InstanceType<typeof MockLanguageModelV2>> = { lead: plannerModel, qa: qaModel, specialist: runnerModel, dev: runnerModel };
const deps = {
  db: hqdb, brain: createBrain(), loadRole: (id: string) => loadRole(id), agentsDir: config.agentsDir, qaThreshold: 85,
  pickModel: async (role: string) => {
    if (role === 'reports') throw new Error('no reports model in the integration test (templates are used)');
    const model = models[role] ?? runnerModel;
    const provider = 'anthropic', modelId = 'claude-haiku-mock';
    return { model, provider, modelId, recordCall: (u: object) => costUsd(provider, modelId, u) };
  },
  onProviderQuota: () => undefined,
  log: (m: string, e?: unknown) => { workerLogs.push(e === undefined ? m : `${m} ${String(e)}`); if (process.env.IT_DEBUG) console.log(`  [worker] ${m}`, e ?? ''); },
};
const loop = new WorkerLoop(deps, { pollIntervalMs: 0, maxParallelTasks: 2, pausedCheckMs: 0 });
async function settle() {
  for (;;) {
    const l = loop as unknown as { planning: Promise<unknown> | null; reviewing: Promise<unknown> | null; running: Map<string, Promise<unknown>> };
    const ps = [...l.running.values(), l.planning, l.reviewing].filter(Boolean);
    if (!ps.length) return;
    await Promise.allSettled(ps);
  }
}
async function tickUntil(what: string, cond: () => Promise<boolean>, max = 12) {
  for (let i = 0; i < max; i++) {
    await loop.tick();
    await settle();
    if (await cond()) return;
  }
  throw new Error(`worker never reached: ${what}\n  last worker logs:\n  ${workerLogs.slice(-8).join('\n  ')}`);
}

// ---------- bot ----------
const botdb = createSupabaseBotDb(service);
const sent: { id: number; html: string }[] = [];
const edits: { id: number; html: string }[] = [];
let nextMsg = 1000;
const sender = {
  send: async (_chat: number, html: string) => { const id = ++nextMsg; sent.push({ id, html }); return id; },
  edit: async (_chat: number, id: number, html: string) => { edits.push({ id, html }); },
};
const CHAT = 42;
const names = new Map<string, string>();
const botNow = () => new Date(`${manilaToday()}T02:30:00Z`); // 10:30 in Manila: outside quiet hours
const notifierState = { lastDecisionSync: new Date(Date.now() - 60_000).toISOString() };
const notify = () => notifierTick({ db: botdb, sender, chatId: CHAT, dashboardUrl: 'https://hq.rizehub.test', names: () => names, now: botNow, log: (m: string) => workerLogs.push(m) }, notifierState);
const pending = new PendingNotes();
const decisionDeps = { db: botdb, pending, names: () => names, dashboardUrl: 'https://hq.rizehub.test', tz: () => 'Asia/Manila' };

const START = new Date(Date.now() - 5_000).toISOString();
let requestId = '';
let planApproval: any;
let copyId = '';
let wireId = '';

// =====================================================================================================
console.log('— dashboard: session + intake');
await step('dashboard loadHq: CEO session is recognised (ceo_users own-row policy) and the office loads', async () => {
  session = ceo;
  const hq = await loaders.loadHq();
  assert.equal(hq.error, undefined, hq.error);
  assert.equal(hq.session.mode, 'live');
  assert.equal(hq.session.isCeo, true);
  assert.equal(hq.snapshot.agents.length, 22);
  assert.equal(hq.snapshot.clients.length, 1);
});

await step('dashboard createRequestAction → create_request RPC (CEO JWT) stages the request', async () => {
  const res = await actions.createRequestAction({ text: 'Launch the Madam Muse bundle page: copy + wireframe', priority: 'high', dueDate: '2026-10-02', clientSlug: 'madam-muse' });
  assert.equal(res.ok, true, res.error);
  requestId = res.id;
  assert.match(requestId, /^[0-9a-f-]{36}$/);
  const r = await svc.request(requestId);
  assert.equal(r.status, 'staged');
  assert.equal(r.source, 'dashboard');
  assert.equal(r.client_id, '33333333-3333-4333-8333-333333333333');
  const reqs = await loaders.loadRequests(ceo);
  assert.equal(reqs[0].id, requestId);
});

console.log('— worker: planning');
await step('worker tick → claim_request_for_planning → COO plan → submit_plan (plan_review, approval pending)', async () => {
  await tickUntil('request in plan_review', async () => (await svc.request(requestId)).status === 'plan_review', 2);
  [planApproval] = await svc.approvals({ request_id: requestId, kind: 'plan' });
  assert.ok(planApproval, 'plan approval exists');
  assert.equal(planApproval.status, 'pending');
  assert.equal(planApproval.agent_id, 'coo');
  assert.equal(planApproval.payload.tasks.length, 2);
  assert.equal(await svc.agentStatus('coo'), 'waiting');
  const screen = await hqdb.getAgentScreen('coo');
  assert.equal(screen?.app, 'whiteboard');
  assert.equal(screen?.progress, 100);
  assert.equal(plannerModel.doGenerateCalls.length, 1);
});

console.log('— bot: approval notification, then dashboard decides');
await step('bot notifier: pending approval without telegram_message_id is sent once and the id stored', async () => {
  const r = await notify();
  assert.equal(r.errors, 0);
  assert.equal(r.sent, 1);
  const [ap] = await svc.approvals({ id: planApproval.id });
  assert.equal(Number(ap.telegram_message_id), sent[0]!.id);
  assert.match(sent[0]!.html, /Madam Muse bundle launch/);
  assert.equal((await notify()).sent, 0, 'not re-sent');
});

await step('dashboard decideApprovalAction(approve) → decide_approval → tasks created with dependency', async () => {
  const res = await actions.decideApprovalAction({ id: planApproval.id, decision: 'approve', note: null });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.result, 'plan_approved');
  const tasks = await q<any[]>(service.from('tasks').select('*').eq('request_id', requestId));
  copyId = tasks.find((t) => t.work_type === 'landing-copy').id;
  wireId = tasks.find((t) => t.work_type === 'wireframe').id;
  assert.equal((await svc.task(copyId)).status, 'queued');
  const wire = await svc.task(wireId);
  assert.equal(wire.status, 'pending');
  assert.deepEqual(wire.depends_on, [copyId]);
  assert.equal(wire.client_id, '33333333-3333-4333-8333-333333333333');
  assert.equal((await svc.request(requestId)).status, 'in_progress');
  assert.equal(await svc.agentStatus('coo'), 'idle');
});

await step('bot notifier: a dashboard decision edits the Telegram message (decidedSince)', async () => {
  const r = await notify();
  assert.equal(r.synced, 1);
  assert.equal(edits.at(-1)?.id, sent[0]!.id);
});

await step('dashboard: deciding twice → "already decided" (already_approved)', async () => {
  const res = await actions.decideApprovalAction({ id: planApproval.id, decision: 'reject', note: null });
  assert.equal(res.ok, false);
  assert.match(res.error, /Already decided \(approved\)/);
});

console.log('— worker: specialist + QA (fail once, then pass)');
await step('worker: claim → runner (report_progress + submit_output) → QA fails → revision → QA passes → awaiting CEO', async () => {
  await tickUntil('copy task awaiting_ceo', async () => (await svc.task(copyId)).status === 'awaiting_ceo');
  const reviews = await q<any[]>(service.from('qa_reviews').select('*').eq('task_id', copyId).order('attempt'));
  assert.deepEqual(reviews.map((r) => [r.attempt, r.verdict]), [[1, 'fail'], [2, 'pass']]);
  const copy = await svc.task(copyId);
  assert.equal(copy.revision_count, 1);
  assert.equal(copy.output.summary, 'Bundle landing copy v2');
  assert.ok(copy.tokens_in > 0 && Number(copy.cost_usd) > 0, 'usage recorded on the task');
  const prompts = runnerPrompts.filter((p) => p.taskId === copyId);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!.text, /Move the CTA above the fold/, 'QA fix list reached the maker');
  assert.equal(await svc.agentStatus('seo-1'), 'waiting');
  assert.equal(await svc.agentStatus('qa-lead'), 'idle');
  const [deliv] = await svc.approvals({ task_id: copyId, kind: 'deliverable' });
  assert.equal(deliv.status, 'pending');
  assert.match(deliv.summary, /QA 93/);
  const s = await hqdb.getAgentScreen('seo-1');
  assert.equal(s?.task_id, copyId);
  assert.equal(s?.step_note, 'Drafting Bundle landing copy');
  assert.equal((await hqdb.getAgentScreen('qa-lead'))?.step_note, 'Passed');
});

console.log('— bot: CEO approves in Telegram');
await step('bot: deliverable is sent; ✅ tap → decide_approval(via telegram) → task done, dependent task released', async () => {
  const r = await notify();
  assert.equal(r.sent, 1);
  const [deliv] = await svc.approvals({ task_id: copyId, kind: 'deliverable' });
  const out = await onButton(decisionDeps, CHAT, Number(deliv.telegram_message_id), deliv.id, 'approve');
  assert.equal(out.kind, 'edit');
  assert.equal(out.toast, 'Approved: marked done');
  const [after] = await svc.approvals({ id: deliv.id });
  assert.equal(after.decided_via, 'telegram');
  assert.equal((await svc.task(copyId)).status, 'done');
  assert.equal((await svc.task(wireId)).status, 'queued');
  assert.equal(await svc.agentStatus('seo-1'), 'idle');
  const again = await onButton(decisionDeps, CHAT, Number(deliv.telegram_message_id), deliv.id, 'approve');
  assert.equal(again.toast, 'Already decided');
  assert.equal((await notify()).synced, 0, 'telegram decisions are not re-synced');
});

await step('worker: dependent task runs and passes QA first time', async () => {
  await tickUntil('wire task awaiting_ceo', async () => (await svc.task(wireId)).status === 'awaiting_ceo');
  const reviews = await q<any[]>(service.from('qa_reviews').select('verdict').eq('task_id', wireId));
  assert.deepEqual(reviews.map((r) => r.verdict), ['pass']);
});

await step('bot: ✏️ Changes → note text → decide_approval(changes, note, telegram) → task back in the queue', async () => {
  assert.equal((await notify()).sent, 1);
  const [deliv] = await svc.approvals({ task_id: wireId, kind: 'deliverable' });
  const ask = await onButton(decisionDeps, CHAT, Number(deliv.telegram_message_id), deliv.id, 'changes');
  assert.equal(ask.kind, 'ask_note');
  const res = await onNoteText(decisionDeps, CHAT, 'Add the size guide below the grid');
  assert.equal(res?.reply, '✏️ Sent back for changes.');
  const wire = await svc.task(wireId);
  assert.equal(wire.status, 'queued');
  assert.equal(wire.qa_feedback.source, 'ceo');
  const [ap] = await svc.approvals({ id: deliv.id });
  assert.equal(ap.status, 'changes_requested');
  assert.equal(ap.ceo_note, 'Add the size guide below the grid');
});

await step('worker: revision includes the CEO note, passes QA again', async () => {
  await tickUntil('wire task awaiting_ceo again', async () => (await svc.approvals({ task_id: wireId, kind: 'deliverable', status: 'pending' })).length === 1);
  const prompts = runnerPrompts.filter((p) => p.taskId === wireId);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!.text, /Add the size guide below the grid/);
});

await step('dashboard approves the last deliverable → request done', async () => {
  const [deliv] = await svc.approvals({ task_id: wireId, kind: 'deliverable', status: 'pending' });
  const res = await actions.decideApprovalAction({ id: deliv.id, decision: 'approve', note: null });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.result, 'task_done');
  assert.equal((await svc.request(requestId)).status, 'done');
});

console.log('— end state');
await step('lifecycle end state: request done, agents idle, qa_reviews, activity_log, agent_screens, cost', async () => {
  const busy = await q<any[]>(service.from('agents').select('id,status').neq('status', 'idle'));
  assert.deepEqual(busy, [], `agents not idle: ${JSON.stringify(busy)}`);
  const n = await service.from('qa_reviews').select('id', { count: 'exact', head: true });
  assert.equal(n.count, 4);
  const acts = await q<any[]>(service.from('activity_log').select('action').eq('request_id', requestId));
  const have = new Set(acts.map((a) => a.action));
  for (const a of ['request.created', 'plan.submitted', 'approval.approved', 'approval.changes_requested', 'task.submitted',
    'qa.revision', 'qa.pass', 'usage.plan', 'usage.task', 'usage.qa']) assert.ok(have.has(a), `activity_log has ${a}`);
  const screens = await q<any[]>(service.from('agent_screens').select('agent_id,updated_at').gte('updated_at', START));
  assert.deepEqual(screens.map((s) => s.agent_id).sort(), ['coo', 'qa-lead', 'seo-1', 'uiux-1']);
  const r = await svc.request(requestId);
  assert.ok(Number(r.cost_usd) > 0, 'request cost accumulated');
  assert.equal(r.title, 'Madam Muse bundle launch');
});

await step('dashboard loadLiveSnapshot (CEO): everything the office needs is readable', async () => {
  const s = await loaders.loadLiveSnapshot(ceo);
  assert.equal(s.agents.length, 22);
  assert.ok(s.requests.some((r: any) => r.id === requestId && r.status === 'done'));
  assert.equal(s.tasks.filter((t: any) => t.request_id === requestId && t.status === 'done').length, 2);
  assert.ok(s.approvals.length >= 4);
  assert.equal(s.qaReviews.length, 4);
  assert.ok(s.activity.length > 10);
  assert.equal(s.screens.length, 4);
});

console.log('— worker extras (reads + helpers through PostgREST)');
await step('worker HqDb reads/helpers: listAgents, recentActivity, monthSpend, settings, idle, messages, stale requeue', async () => {
  assert.equal((await hqdb.listAgents()).length, 22);
  assert.ok((await hqdb.recentActivity('seo-1', 5)).length > 0);
  assert.ok((await hqdb.monthSpendUsd()) > 0);
  assert.equal((await hqdb.getSettings()).timezone, 'Asia/Manila');
  assert.equal(await hqdb.setIdleActivity('seo-2', 'coffee'), true);
  assert.equal(await hqdb.requeueStaleTasks(), 0);
  assert.equal(await hqdb.finishAgentTurn('seo-2'), 'idle');
  await hqdb.addAgentMessage('seo-1', 'agent', 'Copy delivered', copyId);
  assert.equal((await hqdb.getTask(copyId))?.status, 'done');
  assert.equal((await hqdb.getClient('33333333-3333-4333-8333-333333333333'))?.slug, 'madam-muse');
});

console.log('— reports: worker writes, bot broadcasts, dashboard reads');
const today = manilaToday();
await step('worker runReportJob(daily_digest) → report_facts + save_report (standups + digest)', async () => {
  const r = await runReportJob({ kind: 'daily_digest', date: today, from: today, days: 1 }, deps);
  assert.ok(r.reportId, 'digest saved');
  assert.ok(r.standups >= 2, `standups: ${r.standups}`);
  const again = await hqdb.saveReport({ agentId: 'ea', date: today, kind: 'daily_digest', bodyMd: 'dup', costUsd: 0 });
  assert.equal(again, null, 'second save_report without overwrite returns null');
  const keys = await hqdb.existingReports(today);
  assert.ok(keys.some((k: any) => k.kind === 'daily_digest'));
});

await step('bot: digest broadcast once (telegram_sent_at), /report facts, latestReport', async () => {
  const r = await notify();
  assert.equal(r.reports, 1);
  const rep = await botdb.latestReport('daily_digest', today);
  assert.ok(rep?.telegram_sent_at, 'marked as sent');
  assert.equal((await notify()).reports, 0);
  const f = await botdb.reportFacts(today);
  assert.ok(f.qa.reviews >= 4);
  assert.ok(f.done.length >= 2);
});

await step('dashboard loadReports(today) as the CEO', async () => {
  const r = await dashReports.loadReports(today);
  assert.equal(r.error, undefined, r.error);
  assert.ok(JSON.stringify(r).includes('daily_digest'));
});

await step('dashboard vault/client loaders as the CEO (column grants on client_credentials)', async () => {
  const list = await dashVault.loadClientSummaries();
  assert.equal(list.error, undefined, list.error);
  const detail = await dashVault.loadClientDetail('33333333-3333-4333-8333-333333333333');
  assert.equal(detail.error, undefined, detail.error);
  assert.equal(detail.data?.credentials?.length, 1);
}, { critical: false });

console.log('— pause, Telegram intake, planning failure');
let tgRequest = '';
await step('bot /pause (set_paused) stops the worker from claiming; /resume lets it plan', async () => {
  await botdb.setPaused(true);
  assert.equal((await botdb.getSettings()).paused, true);
  const created = await botdb.createRequest({ text: 'Write a blog post about bundles', priority: 'normal', dueDate: null, clientSlug: 'madam-muse' });
  assert.equal(created.clientFound, true);
  tgRequest = created.id;
  await loop.tick(); await settle();
  assert.equal((await svc.request(tgRequest)).status, 'staged', 'paused worker did not plan');
  await botdb.setPaused(false);
  await tickUntil('telegram request planned or failed', async () => (await svc.request(tgRequest)).status !== 'staged', 2);
});

await step('invalid plan twice → planning_failed → "COO couldn\'t plan this" approval → bot ❌ reject', async () => {
  assert.equal((await svc.request(tgRequest)).status, 'failed');
  const [ap] = await svc.approvals({ request_id: tgRequest });
  assert.equal(ap.payload.type, 'planning_failed');
  assert.equal(await svc.agentStatus('coo'), 'waiting');
  assert.equal((await notify()).sent, 1);
  const out = await onButton(decisionDeps, CHAT, 1, ap.id, 'reject');
  assert.equal(out.toast, 'Rejected');
  assert.equal(await svc.agentStatus('coo'), 'idle');
});

await step('bot reads: pendingApprovals count, spendRows, agents', async () => {
  const p = await botdb.pendingApprovals(10);
  assert.equal(p.total, 0);
  assert.ok((await botdb.spendRows(START)).length > 0);
  assert.equal((await botdb.agents()).length, 22);
});

// =====================================================================================================
console.log('— security');
await step('non-CEO user: loadHq says not the CEO, loaders see nothing', async () => {
  session = other;
  const hq = await loaders.loadHq();
  assert.equal(hq.session.isCeo, false);
  const s = await loaders.loadLiveSnapshot(other);
  assert.deepEqual([s.agents.length, s.requests.length, s.tasks.length, s.approvals.length, s.activity.length], [0, 0, 0, 0, 0]);
  session = ceo;
}, { critical: false });

await step('non-CEO user: server actions are refused (hq_guard → 42501)', async () => {
  session = other;
  try {
    const c = await actions.createRequestAction({ text: 'sneaky', priority: 'normal', dueDate: null, clientSlug: null });
    assert.equal(c.ok, false);
    assert.match(c.error, /not the CEO/);
    const [ap] = await svc.approvals({ request_id: requestId, kind: 'plan' });
    const d = await actions.decideApprovalAction({ id: ap.id, decision: 'approve', note: null });
    assert.equal(d.ok, false);
    assert.match(d.error, /not the CEO/);
  } finally { session = ceo; }
}, { critical: false });

await step('non-CEO user: direct table writes are filtered by RLS', async () => {
  const upd = await other.from('approvals').update({ status: 'approved' }).eq('status', 'pending').select('id');
  assert.equal(upd.error, null);
  assert.deepEqual(upd.data, []);
  const ins = await other.from('requests').insert({ source: 'dashboard', raw_text: 'x' });
  assert.ok(ins.error, 'insert refused');
}, { critical: false });

await step('anon: no rows, and workflow RPCs are not executable', async () => {
  assert.deepEqual(await q(anon.from('agents').select('id')), []);
  for (const [fn, args] of [['create_request', { p_source: 'dashboard', p_raw_text: 'x' }], ['claim_next_task', {}], ['report_facts', { p_from: today }], ['decide_approval', { p_approval: planApproval.id, p_decision: 'approve' }]] as const) {
    const r = await anon.rpc(fn, args);
    assert.ok(r.error, `${fn} refused`);
    assert.match(r.error!.message, /permission denied/, `${fn}: ${r.error!.message}`);
  }
}, { critical: false });

await step('CEO JWT cannot read client_credentials.secret_cipher (metadata only) or call worker-only vault RPCs', async () => {
  const bad = await ceo.from('client_credentials').select('id,secret_cipher');
  assert.ok(bad.error, 'secret_cipher refused');
  assert.match(bad.error!.message, /permission denied/);
  const star = await ceo.from('client_credentials').select('*');
  assert.ok(star.error, 'select * refused too (includes secret columns)');
  const meta = await q<any[]>(ceo.from('client_credentials').select('id,label,status'));
  assert.equal(meta.length, 1);
  const cred = meta[0].id;
  const sealed = await ceo.rpc('vault_get_sealed', { p_credential: cred });
  assert.ok(sealed.error && /permission denied/.test(sealed.error.message), `vault_get_sealed: ${sealed.error?.message ?? 'allowed!'}`);
  const w = await ceo.from('client_credentials').update({ label: 'x' }).eq('id', cred).select('id');
  assert.ok(w.error, 'CEO cannot write credentials directly');
  const svcRead = await q<any[]>(service.from('client_credentials').select('secret_cipher'));
  assert.equal(svcRead.length, 1, 'service role (worker) can read ciphertext');
}, { critical: false });

await step('no unauthenticated call succeeds: a request with no apikey/JWT cannot pass hq_guard', async () => {
  // hq_can_operate is service-role only (20260928070000_review_fixes.sql): refused outright, never "true".
  const r = await fetch(`${URL_}/rest/v1/rpc/hq_can_operate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const body = await r.json();
  assert.ok(body === false || (r.status >= 400 && /permission denied/.test(JSON.stringify(body))), `got HTTP ${r.status} ${JSON.stringify(body)}`);
  const c = await fetch(`${URL_}/rest/v1/rpc/create_request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"p_source":"dashboard","p_raw_text":"x"}' });
  assert.ok(c.status >= 400, `create_request without a JWT: HTTP ${c.status}`);
}, { critical: false });

// Supabase grants EXECUTE on every new public function to anon + authenticated, and PostgREST exposes it
// at /rpc/<name>. A SECURITY DEFINER function reachable that way must check the caller itself.
const psql = async (sql: string) => {
  const { execFileSync } = await import('node:child_process');
  return execFileSync(env('IT_PSQL'), [env('IT_PG_URL'), '-X', '-A', '-t', '-F', '|', '-c', sql], { encoding: 'utf8' }).trim();
};
const HARMLESS_DEFINERS = ['is_ceo', 'hq_can_operate']; // return booleans about the caller only
const unguardedDefiners = async (role: string) => (await psql(
  `select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and has_function_privilege('${role}', p.oid, 'execute')
      and pg_get_functiondef(p.oid) !~ '(hq_guard|vault_service_guard)\\(\\)|is_ceo\\(\\)'
      and p.proname <> all (array['${HARMLESS_DEFINERS.join("','")}']) order by 1`)).split('\n').filter(Boolean);

await step('SECURITY DEFINER functions callable by anon / authenticated all guard the caller', async () => {
  const bad = { anon: await unguardedDefiners('anon'), authenticated: await unguardedDefiners('authenticated') };
  assert.deepEqual(bad, { anon: [], authenticated: [] });
}, { critical: false });

await step('anon key cannot write activity_log through /rpc/hq_log', async () => {
  const r = await anon.rpc('hq_log', { p_actor: 'ceo', p_action: 'approval.approved', p_request: null, p_task: null, p_detail: { forged: true } });
  const forged = await q<any[]>(service.from('activity_log').select('id').eq('detail->>forged', 'true'));
  await service.from('activity_log').delete().eq('detail->>forged', 'true');
  assert.ok(r.error && forged.length === 0, `anon inserted a forged "ceo approval.approved" row (HTTP ${r.status})`);
  const c = await ceo.rpc('hq_log', { p_actor: 'ceo', p_action: 'approval.approved', p_request: null, p_task: null, p_detail: { forged: true } });
  assert.ok(c.error && /permission denied/.test(c.error.message), `authenticated hq_log: ${c.error?.message ?? 'allowed!'}`);
  for (const fn of ['refresh_agent_status', 'finish_agent_turn'] as const) {
    const x = await ceo.rpc(fn, { p_agent: 'seo-1' });
    assert.ok(x.error && /permission denied/.test(x.error.message), `authenticated ${fn}: ${x.error?.message ?? 'allowed!'}`);
  }
}, { critical: false });

console.log('— worker vault through PostgREST (bytea + table-returning RPCs)');
await step('vault: seal → vault_insert_credential (bytea in) → vault_get_for_agent (table out) → open', async () => {
  const crypto = await import('node:crypto');
  const { loadKeyring, seal, open } = await import(path.join(W, 'src/vault/crypto.ts'));
  const { createSupabaseVaultStore, VaultDenied } = await import(path.join(W, 'src/vault/store.ts'));
  const kr = loadKeyring({ VAULT_MASTER_KEY: crypto.randomBytes(32).toString('base64') })!;
  const store = createSupabaseVaultStore(service);
  const id = crypto.randomUUID();
  const clientId = await store.resolveClientId('madam-muse');
  assert.equal(clientId, '33333333-3333-4333-8333-333333333333');
  const newId = await store.insertCredential({
    id, clientId: clientId!, platform: 'shopify', label: 'Staff account', loginUrl: 'https://admin.shopify.com', username: 'hq',
    secretType: 'password', sealed: seal('hunter2-ü', kr, id), twofaMethod: 'none', scopeNotes: 'Theme edits only',
    urlAllowlist: ['admin.shopify.com'], expiresAt: null, grants: ['shopify-dev'],
  });
  assert.equal(newId, id);
  const got = await store.getForAgent(id, 'shopify-dev');
  assert.equal(open(got.sealed, kr, id), 'hunter2-ü');
  assert.deepEqual(got.url_allowlist, ['admin.shopify.com']);
  const sealed = await store.getSealed(id);
  assert.equal(open(sealed!.sealed, kr, id), 'hunter2-ü');
  await assert.rejects(store.getForAgent(id, 'seo-1'), (e: unknown) => e instanceof VaultDenied);
  const list = await store.listForAgent('shopify-dev', clientId!);
  assert.equal(list.granted.length, 1);
  assert.equal(list.not_granted, 1);
  await store.logAccess({ credentialId: id, agentId: 'shopify-dev', taskId: null, action: 'login', success: true, detail: { host: 'admin.shopify.com' } });
  const grants = await ceo.rpc('vault_set_grants', { p_credential: id, p_agents: ['shopify-dev', 'webflow-dev'] });
  assert.equal(grants.error, null, grants.error?.message);
  assert.deepEqual(grants.data, ['shopify-dev', 'webflow-dev']);
  // write allowlist (read-only by default): stored by the worker, returned to the agent, readable + editable by the CEO
  assert.deepEqual(got.write_allowlist, []);
  const rwId = crypto.randomUUID();
  await store.insertCredential({
    id: rwId, clientId: clientId!, platform: 'shopify', label: 'Theme assets token', loginUrl: null, username: null,
    secretType: 'api_token', sealed: seal('shpat_x', kr, rwId), twofaMethod: 'none', scopeNotes: null,
    urlAllowlist: ['https://mm.myshopify.com/admin/api'], writeAllowlist: ['PUT /admin/api/2025-07/themes/1/assets.json'], expiresAt: null, grants: ['shopify-dev'],
  });
  assert.deepEqual((await store.getForAgent(rwId, 'shopify-dev')).write_allowlist, ['PUT /admin/api/2025-07/themes/1/assets.json']);
  const meta = await q<any[]>(ceo.from('client_credentials').select('id,write_allowlist').eq('id', rwId));
  assert.deepEqual(meta[0].write_allowlist, ['PUT /admin/api/2025-07/themes/1/assets.json']);
  const up = await ceo.rpc('vault_update_credential', {
    p_id: rwId, p_label: 'Theme assets token', p_login_url: null, p_username: null, p_twofa: 'none', p_scope_notes: null,
    p_url_allowlist: ['https://mm.myshopify.com/admin/api'], p_expires_at: null, p_write_allowlist: [],
  });
  assert.equal(up.error, null, up.error?.message);
  assert.deepEqual((await store.getForAgent(rwId, 'shopify-dev')).write_allowlist, []);
}, { critical: false });

await step('worker logged no swallowed errors during the lifecycle', async () => {
  const expected = /plan attempt \d invalid|already existed|no model for phrasing/;
  const bad = workerLogs.filter((l) => /fail|crash|error|could not/i.test(l) && !expected.test(l));
  assert.deepEqual(bad, []);
}, { critical: false });

// ---------- static contract check: every literal rpc('fn', { p_…: }) call site vs pg_proc ----------
await step('every rpc() call site in apps/* uses argument names that exist in the SQL signature', async () => {
  const fs = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(env('IT_PSQL'), [env('IT_PG_URL'), '-X', '-A', '-t', '-F', '|', '-c',
    `select proname, coalesce(array_to_string(proargnames[1:pronargs], ','), ''), pronargs - pronargdefaults
       from pg_proc where pronamespace = 'public'::regnamespace`], { encoding: 'utf8' });
  const sigs = new Map<string, { args: string[]; required: number }[]>();
  for (const line of out.trim().split('\n')) {
    const [name, args, required] = line.split('|');
    sigs.set(name!, [...(sigs.get(name!) ?? []), { args: args ? args.split(',') : [], required: Number(required) }]);
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$|fake|Demo|mock/i.test(e.name)) files.push(p);
    }
  };
  for (const app of ['worker', 'bot', 'dashboard']) walk(path.join(ROOT, 'apps', app, 'src'));
  const problems: string[] = [];
  let checked = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\brpc(?:<[^>]*>)?\(\s*'(\w+)'/g)) {
      const fn = m[1]!;
      const where = `${path.relative(ROOT, file)}:${src.slice(0, m.index).split('\n').length}`;
      const cands = sigs.get(fn);
      if (!cands) { problems.push(`${where}: no SQL function public.${fn}`); continue; }
      // the argument object literal (balanced braces), if any
      let i = m.index! + m[0].length;
      while (/\s/.test(src[i]!)) i++;
      let body = '';
      if (src[i] === ',') {
        i++; while (/\s/.test(src[i]!)) i++;
        if (src[i] === '{') {
          let depth = 0, j = i;
          for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
          body = src.slice(i + 1, j);
        } else continue; // args passed as a variable: not checkable statically
      }
      const top = body.replace(/\{[^{}]*\}/g, '{}').replace(/\([^()]*\)/g, '()');
      const keys = [...top.matchAll(/(?:^|[,{\s])(p_\w+)\s*(?=[:,}]|$)/gm)].map((k) => k[1]!);
      const spread = /\.\.\./.test(top);
      const ok = cands.some((c) => keys.every((k) => c.args.includes(k)) && (spread || c.args.slice(0, c.required).every((a) => keys.includes(a))));
      checked++;
      if (!ok) problems.push(`${where}: ${fn}(${keys.join(', ')}) vs SQL ${cands.map((c) => `(${c.args.join(', ')}; ${c.required} required)`).join(' | ')}`);
    }
  }
  assert.ok(checked > 40, `only ${checked} call sites found`);
  assert.deepEqual(problems, []);
  console.log(`  (${checked} rpc call sites checked)`);
}, { critical: false });

report();
process.exit(failures.length ? 1 : 0);
