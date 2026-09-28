import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolSet } from 'ai';
import { FakeHqDb } from '../fakeHqDb';
import { loadRole } from '../roles';
import { runTask } from '../runner';
import { makeDeps, mockModel, promptText, toolCalls } from '../testing';
import { createRizehubTools, stableStringify, type OnboardingPayload } from '../tools/rizehub';
import { RizehubClient } from './client';
import { rizehubConfig, setRizehubForTests } from './config';
import { MOCK_KEYS, MockRizehub, mockFetch } from './mock';
import type { JobItem } from './jobSources';

const AGENTS = ['coo', 'qa-lead', 'prospector', 'pipeline', 'ea', 'client-success', 'job-scout', 'seo-1'];

function setup(agent: string, o: { jobDelayMs?: number; jobWaitMs?: number; clientId?: string | null; feeds?: JobItem[] } = {}) {
  const db = new FakeHqDb(AGENTS);
  const mock = new MockRizehub({ jobDelayMs: o.jobDelayMs ?? 0 });
  const client = new RizehubClient({ baseUrl: 'http://rizehub.mock/agent-api/v1', keys: MOCK_KEYS, fetch: mockFetch(mock), sleep: async () => {} });
  const task = db.addTask({ agent_id: agent, status: 'working', title: 'RizeHub work', work_type: 'lead-finder-search', client_id: o.clientId ?? null });
  const state = { ended: null as null | 'submitted' | 'asked', costUsd: 0, overBudget: false, toolErrors: 0 };
  const deps = makeDeps({ db, model: mockModel([]) });
  const tools = createRizehubTools({
    client, jobWaitMs: o.jobWaitMs ?? 5_000,
    fetchFeeds: async () => ({ items: o.feeds ?? [], sources: [{ id: 'weworkremotely', name: 'WWR', ok: true, items: 1, kept: 1 }] }),
  })({ task, role: loadRole(agent), deps, state });
  const run = async (name: string, input: Record<string, unknown>): Promise<string> =>
    String(await (tools as ToolSet)[name]!.execute!(input as never, { toolCallId: 'c1', messages: [] }));
  return { db, mock, client, task, state, run };
}
const J = (s: string) => JSON.parse(s) as Record<string, unknown>;

test('rizehub_leads search waits for the job, records job + lead refs, updates the office screen (app "leads")', async () => {
  const { db, run } = setup('prospector');
  const res = J(await run('rizehub_leads', { action: 'search', platform: 'shopify', location: 'Australia', industry: 'skincare', signals: ['slow_site'], limit: 5 }));
  const leads = res.leads as { id: string; company: string }[];
  assert.ok(leads.length >= 3);
  const refs = db.rizehub.refs;
  const job = refs.find((r) => r.kind === 'job')!;
  assert.equal(job.summary.status, 'completed');
  assert.equal(job.summary.tool, 'rizehub_leads');
  const leadRefs = refs.filter((r) => r.kind === 'lead');
  assert.equal(leadRefs.length, leads.length);
  const saltbush = leadRefs.find((r) => r.rizehub_id === 'ld_1001')!;
  assert.equal(saltbush.summary.signal, 'LCP 6.2 s');
  assert.equal(saltbush.summary.stage, 'new');
  assert.equal(saltbush.summary.platform, 'shopify');
  assert.match(String(saltbush.summary.app_url), /lead-finder\/leads\/ld_1001$/);
  const screen = db.screens.get('prospector')!;
  assert.equal(screen.app, 'leads');
  assert.match(screen.content ?? '', /Saltbush Skin Co\. · shopify · LCP 6\.2 s/);
});

test('a job still running after the wait parks the task (pending) and ends the turn; job.completed resumes it', async () => {
  const { db, task, state, run } = setup('prospector', { jobDelayMs: 60_000, jobWaitMs: 1 });
  const msg = await run('rizehub_leads', { action: 'search', platform: 'webflow' });
  assert.match(msg, /still running.*paused/);
  assert.equal(state.ended, 'asked');
  assert.equal(db.tasks.get(task.id)!.status, 'pending');
  const jobRef = db.rizehub.refs.find((r) => r.kind === 'job')!;
  assert.equal(jobRef.summary.status, 'pending');
  assert.equal(await db.rizehubJobFinished(jobRef.rizehub_id, 'completed', {}), 'resumed');
  assert.equal(db.tasks.get(task.id)!.status, 'queued');
  assert.match(JSON.stringify(db.tasks.get(task.id)!.qa_feedback), /rizehub_leads/);
});

test('notes, lists and stage changes; "contacted" is refused without an approved send for that lead', async () => {
  const { db, task, run } = setup('pipeline');
  const n = J(await run('rizehub_leads', { action: 'add_notes', lead_id: 'ld_1001', notes: 'Mobile LCP 6.2 s (PSI, 2026-09-28) on /collections/all', fit_score: 84, angle: 'Speed fix before BFCM', findings: ['LCP 6.2 s'] }));
  assert.equal(n.stage, 'researched');
  assert.equal(db.rizehub.refs.find((r) => r.rizehub_id === 'ld_1001')!.summary.fit_score, 84);
  const l = J(await run('rizehub_leads', { action: 'create_list', list_name: '2026-10 skincare AU shopify', lead_ids: ['ld_1001', 'ld_1006'] }));
  assert.equal(l.count, 2);
  assert.equal(db.rizehub.refs.find((r) => r.rizehub_id === 'ld_1006')!.summary.list, '2026-10 skincare AU shopify');
  assert.equal(J(await run('rizehub_leads', { action: 'set_stage', lead_id: 'ld_1001', stage: 'drafted' })).stage, 'drafted');

  assert.match(await run('rizehub_leads', { action: 'set_stage', lead_id: 'ld_1001', stage: 'contacted' }), /^Refused/);
  // an approved send for a *different* lead doesn't count
  const other = await db.requestExternalAction(task.id, 'send_email', { description: 'Email Bondi Brew Supply (ld_1002)' });
  db.rizehub.decide(other, 'approved');
  assert.match(await run('rizehub_leads', { action: 'set_stage', lead_id: 'ld_1001', stage: 'contacted' }), /^Refused/);
  // a pending one neither
  const mine = await db.requestExternalAction(task.id, 'send_email', { description: 'Send first email to Saltbush Skin Co. (lead ld_1001)' });
  assert.match(await run('rizehub_leads', { action: 'set_stage', lead_id: 'ld_1001', stage: 'contacted' }), /^Refused/);
  db.rizehub.decide(mine, 'approved');
  const ok = J(await run('rizehub_leads', { action: 'set_stage', lead_id: 'ld_1001', stage: 'contacted' }));
  assert.equal(ok.stage, 'contacted');
  const ref = db.rizehub.refs.find((r) => r.rizehub_id === 'ld_1001')!;
  assert.equal(ref.summary.approval_id, mine);
  assert.ok(ref.summary.contacted_at);
});

test('API errors come back as text, never thrown into the agent loop', async () => {
  const { mock, run } = setup('prospector');
  assert.match(await run('rizehub_leads', { action: 'get', lead_id: 'ld_nope' }), /RizeHub error not_found: Lead ld_nope not found \(retryable: no\)/);
  mock.failNext(10, 503);
  assert.match(await run('rizehub_leads', { action: 'get', lead_id: 'ld_1001' }), /RizeHub error unavailable.*retryable: yes/);
});

test('rizehub_reports: generate → report ref with preview; notes; publish only via approval, executed by the worker later', async () => {
  const { db, task, mock, run } = setup('ea');
  const r = J(await run('rizehub_reports', { action: 'generate', workspace_id: 'ws_vinylicons', type: 'seo-monthly', from: '2026-09-01', to: '2026-09-30' }));
  const reportId = String(r.id);
  assert.match(String(r.preview_url), /preview\/reports\//);
  assert.equal(typeof (r.change_pct as Record<string, unknown>).sessions, 'number');
  assert.equal(db.rizehub.refs.find((x) => x.kind === 'report')!.summary.status, 'draft');
  assert.equal(J(await run('rizehub_reports', { action: 'add_notes', report_id: reportId, summary: 'Organic clicks grew.', insights: ['a'], next_steps: ['b'] })).ok, true);
  const pub = await run('rizehub_reports', { action: 'publish', report_id: reportId, notify_client: true });
  assert.match(pub, /queued for CEO approval/);
  assert.equal(mock.reports.get(reportId)!.status, 'draft'); // nothing published yet
  const ap = db.approvals.find((a) => a.payload.action_type === 'rizehub.report_publish')!;
  assert.equal(ap.task_id, task.id);
  assert.equal((ap.payload.spec as { rizehub: { report_id: string } }).rizehub.report_id, reportId);
});

test('rizehub_reports: only the EA generates/publishes; SEO can read metrics and add notes', async () => {
  const { run } = setup('seo-1');
  assert.match(await run('rizehub_reports', { action: 'generate', workspace_id: 'ws_vinylicons', type: 'seo-monthly', from: '2026-09-01', to: '2026-09-30' }), /Only the EA/);
  const m = J(await run('rizehub_reports', { action: 'metrics', workspace_id: 'ws_vinylicons', from: '2026-09-01', to: '2026-09-30' }));
  assert.ok((m.metrics as { sessions: number }).sessions > 0);
});

const PAYLOAD: OnboardingPayload = {
  account: { company: 'Saltbush Skin Co.', domain: 'saltbushskin.com.au', primary_contact: { name: 'Mia Tran', email: 'mia@saltbushskin.com.au', role: 'Founder' }, plan: 'seo-retainer', country: 'AU', time_zone: 'Australia/Sydney', test: true },
  workspace: { template: 'seo-retainer', name: 'Saltbush Skin Co.' },
  config: { site_url: 'https://saltbushskin.com.au', platform: 'shopify', services_enabled: ['seo', 'content', 'reports'], report_schedule: { type: 'seo-monthly', day_of_month: 1, time_zone: 'Australia/Sydney' } },
  projects: ['Baseline SEO audit', 'Keyword map'],
};

test('rizehub_onboarding: dry run changes nothing; approval pauses the task; execute runs the approved payload exactly once', async () => {
  const clientId = 'c-1';
  const { db, task, state, mock, run } = setup('client-success', { clientId });
  const accountsBefore = mock.accounts.size;
  const dry = J(await run('rizehub_onboarding', { action: 'dry_run', payload: PAYLOAD }));
  assert.equal(dry.valid, true);
  assert.equal(mock.accounts.size, accountsBefore);

  // execute before any approval: nothing happens
  assert.match(await run('rizehub_onboarding', { action: 'execute' }), /No approved onboarding/);

  const req = await run('rizehub_onboarding', { action: 'request_approval', payload: PAYLOAD });
  assert.match(req, /paused/);
  assert.equal(state.ended, 'asked');
  assert.equal(db.tasks.get(task.id)!.status, 'awaiting_ceo');
  const ap = db.approvals.find((a) => a.payload.action_type === 'rizehub.onboarding')!;
  assert.match(String((ap.payload.spec as { description: string }).description), /Saltbush Skin Co\. \(seo-retainer\), site https:\/\/saltbushskin\.com\.au, seo-monthly report on day 1 \[test account\]/);
  assert.match(await run('rizehub_onboarding', { action: 'execute' }), /still pending/);
  assert.equal(mock.accounts.size, accountsBefore);

  // CEO approves → task resumes; a different payload is refused
  db.rizehub.decide(ap.id, 'approved');
  assert.equal(db.tasks.get(task.id)!.status, 'queued');
  db.tasks.get(task.id)!.status = 'working';
  const changed = { ...PAYLOAD, workspace: { ...PAYLOAD.workspace, template: 'shopify-growth' } };
  assert.match(await run('rizehub_onboarding', { action: 'execute', payload: changed }), /differs from what the CEO approved/);
  assert.equal(mock.accounts.size, accountsBefore);

  const done = J(await run('rizehub_onboarding', { action: 'execute', payload: JSON.parse(stableStringify(PAYLOAD)) }));
  assert.equal(done.ok, true);
  const acc = mock.accounts.get(String(done.account_id))!;
  assert.equal(acc.company, 'Saltbush Skin Co.');
  const ws = mock.workspaces.get(String(done.workspace_id))!;
  assert.equal(ws.config.site_url, 'https://saltbushskin.com.au');
  assert.ok(ws.projects.some((p) => p.name === 'Keyword map'));
  assert.ok(db.approvals.find((a) => a.id === ap.id)!.payload.executed_at);
  assert.equal(db.rizehub.refs.find((r) => r.kind === 'account')!.client_id, clientId);
  assert.ok(db.rizehub.refs.find((r) => r.kind === 'workspace'));
  // the audit headers reached RizeHub with idempotency keys taskId:onboarding:<step>
  assert.ok(mock.audit.some((a) => a.path === '/accounts' && a.task_id === task.id && a.agent_id === 'client-success' && !a.dry_run));

  // second execute: no duplicate account
  const again = J(await run('rizehub_onboarding', { action: 'execute' }));
  assert.equal(again.already_executed, true);
  assert.equal([...mock.accounts.values()].filter((a) => a.company === 'Saltbush Skin Co.').length, 1);
});

test('rizehub_onboarding: duplicates and invalid payloads are refused before any approval', async () => {
  const { db, run } = setup('client-success');
  const dup = J(await run('rizehub_onboarding', { action: 'request_approval', payload: { ...PAYLOAD, account: { ...PAYLOAD.account, company: 'Madam Muse', domain: 'madammuse.co' } } }));
  assert.match(String(dup.refused), /duplicate/);
  const bad = J(await run('rizehub_onboarding', { action: 'request_approval', payload: { ...PAYLOAD, workspace: { template: 'nope', name: 'x' } } }));
  assert.match(String(bad.refused), /dry run has errors/);
  assert.equal(db.approvals.length, 0);
});

test('rizehub_onboarding: invite drafted with send=false; sending needs an approval', async () => {
  const { db, mock, run } = setup('client-success');
  const inv = J(await run('rizehub_onboarding', { action: 'draft_invite', account_id: 'acc_madammuse', invite_email: 'hello@madammuse.co' }));
  assert.equal(inv.status, 'draft');
  assert.match(await run('rizehub_onboarding', { action: 'request_invite_send', invite_id: String(inv.invite_id) }), /queued for CEO approval/);
  assert.equal(mock.invites.get(String(inv.invite_id))!.status, 'draft');
  assert.ok(db.approvals.some((a) => a.payload.action_type === 'rizehub.invite_send'));
});

test('rizehub_readonly: duplicate search, workspace read-back, refs without stealing the task', async () => {
  const { db, run } = setup('qa-lead');
  const s = J(await run('rizehub_readonly', { action: 'accounts_search', domain: 'https://www.madammuse.co/' }));
  assert.equal((s.accounts as unknown[]).length, 1);
  const w = J(await run('rizehub_readonly', { action: 'workspace', id: 'ws_madammuse' }));
  assert.equal(w.template, 'shopify-growth');
  assert.equal(db.rizehub.refs.find((r) => r.kind === 'workspace')!.task_id, null);
});

test('job_tracker: upsert dedupes by canonical URL, applied is CEO-only, pasted links, feeds mark tracked items', async () => {
  const feeds: JobItem[] = [{ url: 'https://weworkremotely.com/remote-jobs/kestrel', title: 'Senior Shopify Developer', company: 'Kestrel Goods', source: 'weworkremotely', platform_tags: ['shopify'], rate: null, posted_at: '2026-09-25T10:15:00.000Z', summary: 'Liquid', location: null }];
  const { db, run } = setup('job-scout', { feeds });
  const a = J(await run('job_tracker', { action: 'upsert', url: 'https://www.weworkremotely.com/remote-jobs/kestrel/?utm_source=rss', title: 'Senior Shopify Developer', company: 'Kestrel Goods', source: 'weworkremotely', fit_score: 86, fit_reasons: ['Liquid OS 2.0'], status: 'shortlisted' }));
  assert.equal(a.created, true);
  const b = J(await run('job_tracker', { action: 'upsert', url: 'https://weworkremotely.com/remote-jobs/kestrel', title: 'Senior Shopify Developer', draft: 'Hi Kestrel team…', status: 'drafted' }));
  assert.equal(b.created, false);
  assert.equal(db.rizehub.jobs.length, 1);
  assert.equal(db.rizehub.jobs[0]!.fit_score, 86);
  assert.equal(db.rizehub.jobs[0]!.status, 'drafted');
  // zod refuses "applied" for agents; the RPC/fake refuses it too
  assert.equal(db.screens.get('job-scout')!.app, 'sheet');
  await assert.rejects(db.upsertJobOpportunity({ url: 'https://x.test/j', title: 'x', status: 'applied' }, null), /set by the CEO/);

  const p = J(await run('job_tracker', { action: 'add_link', url: 'https://www.onlinejobs.ph/jobseekers/job/1234567' }));
  assert.equal(p.status, 'found');
  assert.equal(db.rizehub.jobs.find((j) => j.source === 'pasted')!.url, 'https://onlinejobs.ph/jobseekers/job/1234567');

  const f = J(await run('job_tracker', { action: 'fetch_feeds' }));
  assert.equal((f.items as { tracked_status: string }[])[0]!.tracked_status, 'drafted');

  const fu = J(await run('job_tracker', { action: 'schedule_follow_up', url: 'https://weworkremotely.com/remote-jobs/kestrel', follow_up_days: 5 }));
  assert.ok((fu.job as { follow_up_at: string }).follow_up_at);
  const list = J(await run('job_tracker', { action: 'list', statuses: ['drafted'] }));
  assert.equal(list.count, 1);
});

test('runner wiring: the prospector role gets the real rizehub_leads tool (no stub) and its results reach the model', async () => {
  const mock = new MockRizehub({ jobDelayMs: 0 });
  const client = new RizehubClient({ baseUrl: 'http://rizehub.mock/agent-api/v1', keys: MOCK_KEYS, fetch: mockFetch(mock), sleep: async () => {} });
  setRizehubForTests({ client, mock, cfg: { ...rizehubConfig({}), jobWaitMs: 1000 } });
  try {
    const db = new FakeHqDb(AGENTS);
    const task = db.addTask({ agent_id: 'prospector', status: 'working', title: 'Find AU Shopify leads', work_type: 'lead-finder-search' });
    const model = mockModel([
      toolCalls([{ name: 'rizehub_leads', input: { action: 'search', platform: 'shopify', location: 'Australia', limit: 3 } }]),
      toolCalls([{ name: 'submit_output', input: { summary: '3 leads found' } }]),
    ]);
    const r = await runTask({ ...task }, makeDeps({ db, model }));
    assert.equal(r.status, 'submitted');
    assert.match(promptText(model.doGenerateCalls[1]!), /Saltbush Skin Co/);
    assert.doesNotMatch(promptText(model.doGenerateCalls[1]!), /not connected yet/);
    assert.equal(db.rizehub.refs.filter((x) => x.kind === 'lead').length, 3);
  } finally { setRizehubForTests(null); }
});
