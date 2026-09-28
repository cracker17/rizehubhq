import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeHqDb } from '../fakeHqDb';
import { RizehubClient } from './client';
import { MOCK_KEYS, MockRizehub, mockFetch } from './mock';
import { executeApprovedActions, importJobFeeds, pollPendingJobs } from './background';
import type { JobItem } from './jobSources';

function setup(jobDelayMs = 0) {
  let now = Date.parse('2026-09-28T02:00:00Z');
  const mock = new MockRizehub({ jobDelayMs, now: () => now });
  const client = new RizehubClient({ baseUrl: 'http://rizehub.mock/agent-api/v1', keys: MOCK_KEYS, fetch: mockFetch(mock), sleep: async () => {} });
  const db = new FakeHqDb(['coo', 'sales']);
  return { mock, client, db, advance: (ms: number) => { now += ms; } };
}

test('approved report publish is executed once by the worker; pending and rejected ones are not', async () => {
  const { mock, client, db } = setup();
  const ctx = { taskId: 't', agentId: 'coo' };
  const acc = await client.generateReport(ctx, 'ws_vinylicons', { type: 'seo-monthly', period: { from: '2026-09-01', to: '2026-09-30' } });
  const rid = (await client.getJob(ctx, acc.job_id)).result!.report_id!;
  await client.addReportNotes(ctx, rid, { summary: 'Up and to the right', insights: [], next_steps: [] });
  const task = db.addTask({ agent_id: 'coo', status: 'working' });
  const spec = (id: string) => ({ description: 'Publish', rizehub: { op: 'report_publish', report_id: id, notify_client: true } });
  const pending = await db.requestExternalAction(task.id, 'rizehub.report_publish', spec(rid));
  assert.equal(await executeApprovedActions(db, client), 0);
  assert.equal(mock.reports.get(rid)!.status, 'draft');

  db.rizehub.decide(pending, 'approved');
  assert.equal(await executeApprovedActions(db, client), 1);
  assert.equal(mock.reports.get(rid)!.status, 'published');
  const ap = db.approvals.find((a) => a.id === pending)!;
  assert.ok(ap.payload.executed_at);
  assert.equal((ap.payload.execution as { status: string }).status, 'published');
  assert.equal(db.rizehub.refs.find((r) => r.kind === 'report' && r.rizehub_id === rid)!.summary.status, 'published');
  assert.equal(await executeApprovedActions(db, client), 0); // exactly once
  assert.ok(mock.audit.some((a) => a.path === `/reports/${rid}/publish` && a.task_id === task.id && a.agent_id === 'coo' && a.status === 200));

  const rejected = await db.requestExternalAction(task.id, 'rizehub.invite_send', { rizehub: { op: 'invite_send', invite_id: 'inv_x' } });
  db.rizehub.decide(rejected, 'rejected');
  assert.equal(await executeApprovedActions(db, client), 0);
});

test('a failing action is recorded (last_error) and retried later; non-retryable errors stop', async () => {
  const { mock, client, db } = setup();
  const task = db.addTask({ agent_id: 'coo', status: 'working' });
  const inv = await client.draftInvite({ taskId: task.id, agentId: 'coo' }, 'acc_madammuse', { email: 'hello@madammuse.co' });
  const ap = await db.requestExternalAction(task.id, 'rizehub.invite_send', { rizehub: { op: 'invite_send', invite_id: inv.id } });
  db.rizehub.decide(ap, 'approved');
  mock.failNext(10, 503, 'unavailable', { match: /send$/ });
  assert.equal(await executeApprovedActions(db, client), 0);
  const row = db.approvals.find((a) => a.id === ap)!;
  assert.equal((row.payload.last_error as { code: string }).code, 'unavailable');
  mock.clearFaults();
  assert.equal(await executeApprovedActions(db, client), 1);
  assert.equal(mock.invites.get(inv.id)!.status, 'sent');

  const bogus = await db.requestExternalAction(task.id, 'rizehub.invite_send', { rizehub: { op: 'invite_send', invite_id: 'inv_missing' } });
  db.rizehub.decide(bogus, 'approved');
  assert.equal(await executeApprovedActions(db, client), 0);
  assert.equal((db.approvals.find((a) => a.id === bogus)!.payload.last_error as { retryable: boolean }).retryable, false);
  assert.equal(await executeApprovedActions(db, client), 0); // not retried forever
});

test('polling resumes a parked task when its job completed without a webhook', async () => {
  const { client, db, advance } = setup(10_000);
  const task = db.addTask({ agent_id: 'sales', status: 'working' });
  const acc = await client.searchLeads({ taskId: task.id, agentId: 'sales' }, { platform: 'shopify' });
  await db.parkTaskForJob(task.id, acc.job_id, { type: 'lead_search', tool: 'rizehub_leads' });
  assert.equal(await pollPendingJobs(db, client, undefined, 0), 0); // still running
  assert.equal(db.tasks.get(task.id)!.status, 'pending');
  advance(11_000);
  assert.equal(await pollPendingJobs(db, client, undefined, 0), 1);
  assert.equal(db.tasks.get(task.id)!.status, 'queued');
  assert.equal(db.rizehub.refs.find((r) => r.rizehub_id === acc.job_id)!.summary.status, 'completed');
});

test('job feed import adds only new URLs as "found", capped per run', async () => {
  const { db } = setup();
  const item = (n: number): JobItem => ({ url: `https://board.test/jobs/${n}`, title: `Shopify dev ${n}`, company: 'Co', source: 'remotive', platform_tags: ['shopify'], rate: null, posted_at: null, summary: 'Liquid', location: null });
  await db.upsertJobOpportunity({ url: 'https://board.test/jobs/1', title: 'Shopify dev 1', status: 'skipped' }, null);
  const n = await importJobFeeds(db, async () => ({ items: [1, 2, 3, 4].map(item), sources: [] }), undefined, 2);
  assert.equal(n, 2);
  assert.equal(db.rizehub.jobs.length, 3);
  assert.equal(db.rizehub.jobs.find((j) => j.url.endsWith('/1'))!.status, 'skipped'); // untouched
  assert.ok(db.rizehub.jobs.filter((j) => j.source === 'remotive').every((j) => j.status === 'found'));
});
