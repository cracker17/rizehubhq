import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceCriteria, reviewNext } from './qa';
import { FakeHqDb } from './fakeHqDb';
import { jsonResponse, makeDeps, mockModel, promptText } from './testing';

const CRITERIA = ['H1 contains "shopify speed"', 'Title ≤ 60 characters', 'At least 3 internal links'];
const verdict = (score: number, results: ('pass' | 'fail')[], v: 'pass' | 'fail' = 'pass') => ({
  verdict: v, score, summary: 's',
  checks: CRITERIA.map((criterion, i) => ({ criterion, result: results[i] ?? 'pass', note: 'n' })),
  fix_list: results.includes('fail') ? ['Fix it'] : [],
});

function setup() {
  const db = new FakeHqDb();
  const task = db.addTask({
    agent_id: 'seo-1', status: 'qa_pending', acceptance_criteria: CRITERIA,
    output: { summary: 'Article about shopify speed', content: 'SENTINEL-OUTPUT-BODY' },
  });
  return { db, task };
}

test('passing verdict → record_qa_verdict pass → deliverable awaits the CEO', async () => {
  const { db, task } = setup();
  const model = mockModel([jsonResponse(verdict(92, ['pass', 'pass', 'pass']))]);
  const out = await reviewNext(makeDeps({ db, model }));
  assert.equal(out.status, 'recorded');
  assert.equal(out.status === 'recorded' && out.result, 'pass');
  assert.equal(db.tasks.get(task.id)!.status, 'awaiting_ceo');
  const [, reviewer, , threshold] = db.callsOf('recordQaVerdict')[0]!.args;
  assert.equal(reviewer, 'qa-lead');
  assert.equal(threshold, 85);
  const text = promptText(model.doGenerateCalls[0]!);
  assert.match(text, /SENTINEL-OUTPUT-BODY/);                      // the output
  assert.match(text, /QA checklist: _general/);                     // general checklist
  assert.match(text, /brain\/qa-checklists\/seo-article\.md/);     // work-type checklist
  assert.match(text, /You are the QA Lead/);                        // role
  assert.equal(db.usage[0]?.kind, 'qa');
});

test('failed check or low score → revision with fix list', async () => {
  const { db, task } = setup();
  const model = mockModel([jsonResponse(verdict(90, ['pass', 'fail', 'pass'], 'fail'))]);
  const out = await reviewNext(makeDeps({ db, model }));
  assert.equal(out.status === 'recorded' && out.result, 'revision');
  const t = db.tasks.get(task.id)!;
  assert.equal(t.status, 'queued');
  assert.deepEqual(t.qa_feedback?.fix_list, ['Fix it']);

  const s2 = setup();
  const lowScore = mockModel([jsonResponse(verdict(80, ['pass', 'pass', 'pass']))]);
  const out2 = await reviewNext(makeDeps({ db: s2.db, model: lowScore }));
  assert.equal(out2.status === 'recorded' && out2.pass, false);
  assert.equal(s2.db.tasks.get(s2.task.id)!.status, 'queued');
});

test('threshold comes from deps (QA_THRESHOLD)', async () => {
  const { db, task } = setup();
  const model = mockModel([jsonResponse(verdict(80, ['pass', 'pass', 'pass']))]);
  await reviewNext(makeDeps({ db, model, qaThreshold: 75 }));
  assert.equal(db.tasks.get(task.id)!.status, 'awaiting_ceo');
});

test('an unchecked acceptance criterion turns a pass into a fail', () => {
  const v = verdict(95, ['pass', 'pass', 'pass']);
  const partial = { ...v, checks: v.checks.slice(0, 2) };
  const e = enforceCriteria(partial, CRITERIA);
  assert.equal(e.verdict, 'fail');
  assert.equal(e.checks.length, 3);
  assert.equal(e.checks[2]?.result, 'fail');
});

test('no valid verdict after retry → review goes back to qa_pending (attempt counted)', async () => {
  const { db, task } = setup();
  const model = mockModel([jsonResponse('{"verdict":"maybe"}'), jsonResponse('nope')]);
  const out = await reviewNext(makeDeps({ db, model }));
  assert.equal(out.status, 'deferred');
  assert.equal(db.tasks.get(task.id)!.status, 'qa_pending');
  assert.equal(db.callsOf('recordQaVerdict').length, 0);
  assert.equal(db.callsOf('qaReviewFailed').length, 1);
});

test('no valid verdict 3 times → escalated to the CEO (qa_stuck) instead of looping forever', async () => {
  const { db, task } = setup();
  const bad = () => mockModel([jsonResponse('{"verdict":"maybe"}'), jsonResponse('nope')]);
  for (let i = 1; i <= 2; i++) {
    const out = await reviewNext(makeDeps({ db, model: bad() }));
    assert.equal(out.status, 'deferred');
    assert.equal(db.tasks.get(task.id)!.status, 'qa_pending');
    assert.equal(db.tasks.get(task.id)!.qa_attempts, i);
  }
  const out = await reviewNext(makeDeps({ db, model: bad() }));
  assert.equal(out.status, 'escalated');
  assert.equal(db.tasks.get(task.id)!.status, 'failed');
  assert.equal(db.approvals.at(-1)?.payload.type, 'qa_stuck');
  assert.equal((await reviewNext(makeDeps({ db, model: bad() }))).status, 'idle', 'nothing left to review');
  assert.equal(db.callsOf('qaReviewFailed').length, 3);
  assert.equal(db.callsOf('releaseQaReview').length, 0);
});

test('a live review keeps its heartbeat fresh (the stale sweep never takes it away)', async () => {
  const { db } = setup();
  const model = mockModel([jsonResponse(verdict(92, ['pass', 'pass', 'pass']))]);
  await reviewNext(makeDeps({ db, model }));
  assert.ok(db.heartbeats >= 1);
});
