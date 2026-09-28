import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APICallError } from 'ai';
import { FakeHqDb } from './fakeHqDb';
import { isPausedSetting, WorkerLoop } from './loop';
import { QuotaExhaustedError } from './models/router';
import { runDueReports, runReportJob } from './reportsJob';
import { sampleFacts } from './reportsFixtures';
import { jsonResponse, makeDeps, mockModel, textResponse } from './testing';

const DIGEST = { kind: 'daily_digest' as const, date: '2026-09-28', from: '2026-09-28', days: 1 };

function dbWithFacts() {
  const db = new FakeHqDb();
  db.facts.set('2026-09-28', sampleFacts());
  return db;
}

test('digest job: a standup per active agent + digest; model rephrases, facts stay exact', async () => {
  const db = dbWithFacts();
  // 4 active agents (coo, qa-lead, seo-1, uiux-1) → 4 standup calls, then the headline
  const model = mockModel([
    jsonResponse({ done: ['I planned the Vinyl Icons SEO report and sent it to you'], next: [], blockers: ['The Vinyl Icons SEO report plan needs your OK'] }),
    jsonResponse({ done: ['Reviewed 2 deliverables, 1 passed and 1 went back'], next: ['Review the 1 deliverable waiting'], blockers: [] }),
    jsonResponse({ done: ['Finished the Madam Muse bundle copy, you approved it', 'Sent Meta descriptions to QA twice', 'EXTRA'], next: ['x'], blockers: [] }),
    jsonResponse({ done: [], next: ['Keep going on the bundle wireframe'], blockers: [] }),
    textResponse('One task shipped, two in progress and three items need you; $0.42 spent.'),
  ]);
  const deps = makeDeps({ db, model });
  const r = await runReportJob(DIGEST, deps);

  const standups = db.reports.filter((x) => x.kind === 'standup');
  assert.deepEqual(standups.map((s) => s.agentId).sort(), ['coo', 'qa-lead', 'seo-1', 'uiux-1']);
  assert.equal(r.standups, 4);
  // seo-1's rewrite added an item → rejected, template kept
  const seo = standups.find((s) => s.agentId === 'seo-1')!;
  assert.deepEqual(seo.done, ['Finished “Bundle landing copy” (Madam Muse), approved by you', 'Submitted “Meta descriptions” for QA (2 rounds)']);
  assert.equal(standups.find((s) => s.agentId === 'uiux-1')!.next?.[0], 'Keep going on the bundle wireframe');

  const digest = db.reports.find((x) => x.kind === 'daily_digest')!;
  assert.equal(digest.agentId, 'ea');
  const data = digest.data as { headline: string; counts: { done: number }; spend_usd: number; qa: { pass_rate: number } };
  assert.equal(data.headline, 'One task shipped, two in progress and three items need you; $0.42 spent.');
  assert.equal(data.counts.done, 1);
  assert.equal(data.spend_usd, 0.4211);
  assert.equal(data.qa.pass_rate, 50);
  assert.match(digest.bodyMd, /## Approvals waiting \(2\)/);
  assert.equal(r.modelCalls, 5);
  assert.equal(db.usage.filter((u) => u.kind === 'report').length, 5);
  assert.ok(db.usage.every((u) => u.actor === 'ea'));
});

test('no model available (quota / no key) → templates, report still written', async () => {
  const db = dbWithFacts();
  const deps = { ...makeDeps({ db, model: mockModel([]) }), pickModel: async () => { throw new QuotaExhaustedError('reports', ['no key']); } };
  const r = await runReportJob(DIGEST, deps);
  assert.ok(r.reportId);
  assert.equal(r.modelCalls, 0);
  const digest = db.reports.find((x) => x.kind === 'daily_digest')!;
  assert.equal((digest.data as { headline: string }).headline, '1 task done, 2 in progress, 3 need you; $0.42 spent today.');
  assert.equal(db.reports.filter((x) => x.kind === 'standup').length, 4);
  assert.ok(deps.logs.some((l) => l.includes('using templates')));
});

test('provider 429 mid-run → remaining reports use templates, provider marked exhausted', async () => {
  const db = dbWithFacts();
  const err = new APICallError({ message: 'rate limited', url: 'x', requestBodyValues: {}, statusCode: 429, isRetryable: false });
  const deps = makeDeps({ db, model: mockModel({ error: err }) });
  const r = await runReportJob(DIGEST, deps);
  assert.ok(r.reportId);
  assert.deepEqual(deps.quotaHits, ['google']);
  assert.equal(db.reports.filter((x) => x.kind === 'standup').length, 4);
});

test('runDueReports: Monday 18:30 writes yesterday (catch-up), morning brief window closed, today + weekly; second run is a no-op', async () => {
  const db = dbWithFacts();
  db.settings = { digest_time: '18:00', timezone: 'Asia/Manila' };
  const deps = { ...makeDeps({ db, model: mockModel([]) }), pickModel: async () => { throw new QuotaExhaustedError('reports', ['none']); } };
  const now = new Date('2026-09-28T10:30:00Z');
  const first = await runDueReports(deps, now);
  assert.deepEqual(first.map((r) => `${r.job.kind}:${r.job.date}`), ['daily_digest:2026-09-27', 'daily_digest:2026-09-28', 'weekly:2026-09-28']);
  const weekly = db.reports.find((x) => x.kind === 'weekly')!;
  assert.equal(weekly.agentId, 'coo');
  assert.ok(db.callsOf('reportFacts').some((c) => c.args[0] === '2026-09-21' && c.args[1] === 7));
  const before = db.reports.length;
  assert.deepEqual(await runDueReports(deps, now), []);
  assert.equal(db.reports.length, before);
});

test('runDueReports: standups already written for that day are not regenerated', async () => {
  const db = dbWithFacts();
  await db.saveReport({ agentId: 'seo-1', date: '2026-09-28', kind: 'standup', bodyMd: 'mine', costUsd: 0 });
  await db.saveReport({ agentId: 'ea', date: '2026-09-27', kind: 'daily_digest', bodyMd: 'y', costUsd: 0 });
  await db.saveReport({ agentId: 'coo', date: '2026-09-28', kind: 'weekly', bodyMd: 'w', costUsd: 0 });
  const model = mockModel([textResponse('ignored')]);
  const deps = { ...makeDeps({ db, model }), pickModel: async () => { throw new QuotaExhaustedError('reports', ['none']); } };
  const res = await runDueReports(deps, new Date('2026-09-28T10:30:00Z'));
  assert.equal(res.length, 1);
  assert.equal(res[0]?.standups, 4);
  assert.equal(db.reports.find((x) => x.agentId === 'seo-1' && x.kind === 'standup')!.bodyMd, 'mine');
});

test('morning brief uses yesterday\'s numbers', async () => {
  const db = dbWithFacts();
  const y = sampleFacts('2026-09-27');
  y.spend_usd = 2.5;
  db.facts.set('2026-09-27', y);
  const deps = makeDeps({ db, model: mockModel([]) });
  await runReportJob({ kind: 'morning_brief', date: '2026-09-28', from: '2026-09-28', days: 1 }, deps);
  const m = db.reports.find((x) => x.kind === 'morning_brief')!;
  assert.deepEqual((m.data as { yesterday: unknown }).yesterday, { done: 1, spend_usd: 2.5 });
  assert.match(m.bodyMd, /Yesterday: 1 done, \$2\.50 spent\./);
});

test('paused setting: loop claims nothing (planning, tasks, QA) until resumed', async () => {
  assert.ok(isPausedSetting(true) && isPausedSetting('true') && !isPausedSetting(false) && !isPausedSetting(undefined));
  const db = new FakeHqDb();
  db.settings = { paused: true };
  db.addTask({ agent_id: 'seo-1' });
  db.addRequest({ raw_text: 'x' });
  const deps = makeDeps({ db, model: mockModel([]) });
  const loop = new WorkerLoop(deps, { pollIntervalMs: 10, maxParallelTasks: 2, pausedCheckMs: 0 });
  await loop.tick();
  assert.equal(db.callsOf('claimNextTask').length, 0);
  assert.equal(db.callsOf('claimRequestForPlanning').length, 0);
  assert.equal(db.callsOf('claimQaReview').length, 0);
  assert.ok(deps.logs.some((l) => l.includes('paused by the CEO')));
  db.settings = { paused: false };
  // resume: claiming starts again (task run itself fails fast on the empty mock model; we only care it was claimed)
  await loop.tick();
  assert.equal(db.callsOf('claimNextTask').length >= 1, true);
  assert.ok(deps.logs.some((l) => l.includes('resumed')));
  await loop.stop(2000);
});
