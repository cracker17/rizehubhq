import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptRewrite, activeAgentIds, buildDigest, buildMorningBrief, buildWeekly, digestMarkdown, emptyFacts, templateStandup,
} from './reports';
import { sampleFacts } from './reportsFixtures';

test('active agents: events, finished tasks and spend count; report writes and unknown actors do not', () => {
  assert.deepEqual(activeAgentIds(sampleFacts()), ['coo', 'qa-lead', 'seo-1', 'uiux-1']);
});

test('standup template: done / next / blockers from the facts only', () => {
  const f = sampleFacts();
  const seo = templateStandup('seo-1', f);
  assert.deepEqual(seo.done, ['Finished “Bundle landing copy” (Madam Muse), approved by you', 'Submitted “Meta descriptions” for QA (2 rounds)']);
  assert.deepEqual(seo.next, ['“Meta descriptions” is with QA']);
  assert.deepEqual(seo.blockers, []);
  assert.deepEqual(templateStandup('qa-lead', f).done, ['Reviewed 2 deliverables: 1 passed, 1 sent back']);
  assert.deepEqual(templateStandup('qa-lead', f).next, ['Review 1 deliverable waiting for QA']);
  assert.deepEqual(templateStandup('coo', f).done, ['Planned “Vinyl Icons SEO report” and sent the plan for approval']);
  assert.deepEqual(templateStandup('coo', f).blockers, ['“Vinyl Icons SEO report” plan is waiting for your approval']);
  // the failure approval is not listed twice
  assert.deepEqual(templateStandup('graphic-2', f).blockers, ['“Ad set B” is stuck: Missing brand fonts']);
  assert.deepEqual(templateStandup('shopify-dev', f).next, ['Start “Build bundle section” (Madam Muse) (after its dependencies)']);
});

test('model rewrites may merge but never add items or empty a section', () => {
  const tpl = { done: ['a', 'b'], next: ['c'], blockers: [] };
  assert.ok(acceptRewrite(tpl, { done: ['a and b'], next: ['c!'], blockers: [] }));
  assert.ok(!acceptRewrite(tpl, { done: ['a', 'b', 'invented'], next: ['c'], blockers: [] }));
  assert.ok(!acceptRewrite(tpl, { done: ['a'], next: [], blockers: [] }));
  assert.ok(!acceptRewrite(tpl, { done: ['a'], next: ['c'], blockers: ['new blocker'] }));
});

test('digest: counts, QA rate, spend and per-client lines are exact', () => {
  const d = buildDigest(sampleFacts(), 4);
  assert.deepEqual(d.counts, { done: 1, in_progress: 2, blocked: 1, approvals_waiting: 2, requests_created: 3 });
  assert.deepEqual(d.qa, { reviews: 2, passed: 1, pass_rate: 50 });
  assert.equal(d.spend_usd, 0.4211);
  assert.equal(d.headline, '1 task done, 2 in progress, 3 need you; $0.42 spent today.');
  assert.deepEqual(d.clients, [
    { name: 'Madam Muse', done: 1, in_progress: 1, blocked: 0, spend_usd: 0.35 },
    { name: 'Vinyl Icons', done: 0, in_progress: 1, blocked: 1, spend_usd: 0 },
  ]);
  assert.equal(d.done[0]?.note, '2 revisions');
  const md = digestMarkdown('2026-09-28', d, new Map([['seo-1', 'SEO Writer 1']]));
  assert.match(md, /## Done today \(1\)\n- Bundle landing copy · Madam Muse · SEO Writer 1 \(2 revisions\)/);
  assert.match(md, /## Blocked \/ needs you \(1\)\n- Ad set B · Vinyl Icons · graphic-2 \(Missing brand fonts\)/);
  assert.match(md, /\*\*QA pass rate:\*\* 50% \(1\/2\) · \*\*Spend today:\*\* \$0\.42/);
});

test('empty day digest reads cleanly', () => {
  const d = buildDigest(emptyFacts('2026-09-28'));
  assert.equal(d.headline, '0 tasks done, 0 in progress, nothing waiting on you; $0.00 spent today.');
  assert.equal(d.qa.pass_rate, null);
  assert.match(digestMarkdown('2026-09-28', d, new Map()), /no reviews/);
});

test('morning brief lists queue, approvals and due dates', () => {
  const f = sampleFacts();
  f.due_soon = [{ id: 'r1', title: 'Bundle page', due_date: '2026-10-02', status: 'in_progress', client_name: 'Madam Muse' }];
  const m = buildMorningBrief(f, { done: 5, spend_usd: 1.2 });
  assert.equal(m.headline, 'Good morning. 3 tasks on the board, 2 approvals waiting, 1 due in the next 3 days.');
  assert.equal(m.queue[0]?.note, 'high');
});

test('weekly: tasks by department, daily QA trend over 7 days, bottlenecks', () => {
  const f = sampleFacts('2026-09-21');
  f.to = '2026-09-28';
  f.done.push({ task_id: 't9', title: 'Hero graphic', agent_id: 'graphic-2', revision_count: 3 });
  f.qa_by_day = [{ date: '2026-09-22', reviews: 4, passed: 3 }];
  f.qa = { reviews: 10, passed: 6 };
  const w = buildWeekly(f);
  assert.deepEqual(w.range, { from: '2026-09-21', to: '2026-09-27' });
  assert.deepEqual(w.by_department, [{ department: 'content', done: 1 }, { department: 'design', done: 1 }]);
  assert.equal(w.qa_trend.length, 7);
  assert.deepEqual(w.qa_trend[1], { date: '2026-09-22', reviews: 4, pass_rate: 75 });
  assert.equal(w.qa_trend[0]?.pass_rate, null);
  assert.ok(w.bottlenecks.some((b) => b.includes('“Hero graphic” needed 3 QA revisions')));
  assert.ok(w.bottlenecks.some((b) => b.includes('QA first-pass rate is low (60%)')));
  assert.ok(w.bottlenecks.some((b) => b.startsWith('1 task is blocked')));
});
