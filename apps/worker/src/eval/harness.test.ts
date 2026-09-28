import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrain } from '../brain';
import { config } from '../config';
import { loadModelsConfig } from '../models/router';
import { loadRole } from '../roles';
import { UsageError, parseArgs } from './cli';
import { loadFixtures, MakeFixture, ReviewFixture, type Fixture } from './fixtures';
import { buildScorecard, runEval, runFixture, scorecardMarkdown, writeScorecard, type EvalEnv, type EvalResult } from './harness';
import { livePreflight, modelRolesFor, offlineResearch } from './main';
import { ScriptedProvider } from './scripted';

function offlineEnv(over: Partial<EvalEnv> = {}): { env: EvalEnv; scripted: ScriptedProvider; logs: string[] } {
  const scripted = new ScriptedProvider();
  const logs: string[] = [];
  const env: EvalEnv = {
    mode: 'offline', pickModel: scripted.pickModel, onRound: (fx, n) => scripted.setRound(fx, n), research: offlineResearch(),
    brain: createBrain(), loadRole: (id) => loadRole(id), agentsDir: config.agentsDir, qaThreshold: 85, log: (m) => logs.push(m), ...over,
  };
  return { env, scripted, logs };
}

const CRIT = ['Exactly 5 captions', 'Each caption has a CTA', 'Each caption has 5 to 8 hashtags'];
const make = (attempts: { score: number; fail?: number[] }[], id = 'writer-test'): Fixture => MakeFixture.parse({
  id, title: 'Captions', work_type: 'social-captions', instructions: 'Write 5 captions for a fictional client (test fixture).',
  acceptance_criteria: CRIT,
  scripted: { attempts: attempts.map((qa, i) => ({ output: { summary: `attempt ${i + 1}`, content: `CONTENT-${i + 1}` }, qa })) },
});

test('make fixture: runs the real runner + QA; a QA fail goes through the revision loop and passes on attempt 2', async () => {
  const { env, scripted } = offlineEnv();
  const r = await runFixture('writer', make([{ score: 70, fail: [1] }, { score: 91 }]), env);
  assert.equal(r.status, 'pass');
  assert.equal(r.kind, 'make');
  assert.deepEqual(r.attempts.map((a) => [a.qaScore, a.qaPass]), [[70, false], [91, true]]);
  assert.deepEqual(r.attempts[0]!.failedChecks, ['Each caption has a CTA']);
  assert.equal(r.firstScore, 70);
  assert.equal(r.finalScore, 91);
  // The runner asked for the role file's model_role, QA for "qa": always through pickModel, never a hard-coded model.
  assert.deepEqual(scripted.requested, ['writer', 'qa', 'writer', 'qa']);
  assert.deepEqual(r.models, { writer: 'scripted:scripted-writer', qa: 'scripted:scripted-qa' });
});

test('make fixture: still failing after max rounds → fail with a note (QA escalates, no endless loop)', async () => {
  const { env } = offlineEnv();
  const r = await runFixture('writer', make([{ score: 60, fail: [0] }]), env, { maxRounds: 2 });
  assert.equal(r.status, 'fail');
  assert.equal(r.attempts.length, 2);
  assert.match(r.note ?? '', /escalated|still failing/);
});

test('make fixture: a high score with a failed check is still a fail (isQaPass)', async () => {
  const { env } = offlineEnv();
  const r = await runFixture('writer', make([{ score: 95, fail: [2] }]), env, { maxRounds: 1 });
  assert.equal(r.status, 'fail');
  assert.equal(r.finalScore, 95);
});

test('threshold comes from the env: 80 passes at --threshold 75, fails at 85', async () => {
  const fx = make([{ score: 80 }]);
  assert.equal((await runFixture('writer', fx, offlineEnv({ qaThreshold: 75 }).env, { maxRounds: 1 })).status, 'pass');
  assert.equal((await runFixture('writer', fx, offlineEnv().env, { maxRounds: 1 })).status, 'fail');
});

const review = (expect: 'pass' | 'fail', score: number, fail: number[] = []) => ReviewFixture.parse({
  id: `qa-${expect}-${score}`, kind: 'review', maker: 'writer', expect, title: 'Review captions', work_type: 'social-captions',
  instructions: 'Review 5 captions for a fictional client (test fixture).', acceptance_criteria: CRIT,
  deliverable: { summary: 's', content: 'c', links: ['https://kalamansiandclay.example/'] },
  scripted: { qa: { score, fail } },
});

test('review fixture (qa-lead): pass when QA reaches the expected verdict, fail when it does not; no network offline', async () => {
  const { env, scripted } = offlineEnv();
  const t0 = Date.now();
  const ok = await runFixture('qa-lead', review('fail', 55, [0]), env);
  assert.equal(ok.status, 'pass');
  assert.equal(ok.kind, 'review');
  assert.equal(ok.expected, 'fail');
  assert.ok(Date.now() - t0 < 5000, 'offline QA evidence must not wait on the network');
  const wrong = await runFixture('qa-lead', review('pass', 55, [0]), env);
  assert.equal(wrong.status, 'fail');
  assert.match(wrong.note ?? '', /QA said fail, expected pass/);
  assert.deepEqual(scripted.requested, ['qa', 'qa']);
});

test('a crash never throws out of the harness: status error with the reason', async () => {
  const { env } = offlineEnv({ loadRole: () => { throw new Error('broken role file'); } });
  const r = await runFixture('writer', make([{ score: 90 }]), env, { maxRounds: 1 });
  assert.equal(r.status, 'error');
  assert.match(r.note ?? '', /broken role file/);
});

test('full offline eval over the committed fixtures: every role M10-ready (this is what CI runs)', async () => {
  const { env } = offlineEnv();
  const results = await runEval(loadFixtures(), env);
  const card = buildScorecard(results, { mode: 'offline', profile: 'scripted', threshold: 85 });
  assert.equal(card.allPassed, true, results.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.note}`).join('\n'));
  assert.equal(card.roles.length, 6);
  for (const r of card.roles) assert.ok(r.ready && r.passed >= 3, r.role);
  assert.ok(results.some((r) => r.attempts.length > 1), 'at least one fixture exercises the revision loop');
});

const result = (over: Partial<EvalResult>): EvalResult => ({
  role: 'writer', id: 'x', title: 'T | pipe', workType: 'seo-article', kind: 'make', status: 'pass', finalScore: 90, firstScore: 80,
  attempts: [{ attempt: 1, qaScore: 90, qaPass: true, failedChecks: [] }], models: { writer: 'google:m', qa: 'google:m' }, costUsd: 0.0123,
  approvals: [], durationMs: 1, ...over,
});

test('scorecard: per-role readiness needs 3 passing tasks and no failures; markdown + JSON written (timestamped + latest)', () => {
  const card = buildScorecard([
    result({ id: 'a' }), result({ id: 'b' }), result({ id: 'c', status: 'fail', finalScore: 70, note: 'QA still failing' }),
    result({ role: 'sales', id: 'd' }), result({ role: 'sales', id: 'e' }), result({ role: 'sales', id: 'f' }),
  ], { mode: 'live', profile: 'free', threshold: 85, now: new Date('2026-09-29T01:02:03.456Z') });
  const writer = card.roles.find((r) => r.role === 'writer')!;
  assert.deepEqual([writer.passed, writer.total, writer.ready, writer.avgScore], [2, 3, false, 83]);
  assert.equal(card.roles.find((r) => r.role === 'sales')!.ready, true);
  assert.equal(card.allPassed, false);
  const md = scorecardMarkdown(card);
  assert.match(md, /\| writer \| 2\/3 \| 83 \| \$0\.0369 \| no \|/);
  assert.match(md, /T \\\| pipe/, 'pipes escaped in table cells');
  assert.match(md, /1 of 6 task\(s\) did not pass/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-card-'));
  const files = writeScorecard(card, path.join(dir, 'reports', 'eval'));
  assert.equal(path.basename(files.json), 'role-eval-live-20260929-010203Z.json');
  const names = fs.readdirSync(path.join(dir, 'reports', 'eval')).sort();
  assert.deepEqual(names, ['latest-live.json', 'latest-live.md', 'role-eval-live-20260929-010203Z.json', 'role-eval-live-20260929-010203Z.md']);
  assert.equal(JSON.parse(fs.readFileSync(files.json, 'utf8')).results.length, 6);
});

test('cli args: roles, --live, --max-rounds, --threshold, pnpm "--" separator; bad input is a usage error', () => {
  assert.deepEqual(parseArgs([]).roles.length, 6);
  const a = parseArgs(['--', '--role', 'writer,sales', '--role=writer', '--live', '--max-rounds', '2', '--threshold=90', '--out', 'x']);
  assert.deepEqual([a.roles, a.live, a.maxRounds, a.threshold, a.out], [['writer', 'sales'], true, 2, 90, 'x']);
  assert.throws(() => parseArgs(['--role', 'ceo']), UsageError);
  assert.throws(() => parseArgs(['--max-rounds', '0']), UsageError);
  assert.throws(() => parseArgs(['--threshold']), UsageError);
  assert.throws(() => parseArgs(['--nope']), UsageError);
});

test('live pre-flight: missing keys give a clear per-role reason; a key makes it pass; paid profile needs a budget', () => {
  const cfg = loadModelsConfig();
  const needed = modelRolesFor(['writer', 'qa-lead']);
  assert.deepEqual(needed.sort(), ['qa', 'writer']);
  const none = livePreflight(cfg, 'free', needed, {}, 0);
  assert.equal(none.length, 2);
  assert.match(none.join('\n'), /model role "writer": .*no GOOGLE_GENERATIVE_AI_API_KEY/);
  assert.deepEqual(livePreflight(cfg, 'free', needed, { GROQ_API_KEY: 'gsk_test' }, 0), []);
  const paid = livePreflight(cfg, 'paid', ['qa'], { OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-ant-x' }, 0);
  assert.match(paid.join('\n'), /monthly budget reached/);
  assert.match(livePreflight(cfg, 'nope', needed, {}, 0)[0]!, /not one of/);
});
