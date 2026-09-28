import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { QaVerdict } from '@rizehubhq/shared';
import { config } from '../config';
import { loadRole } from '../roles';
import { EVAL_ROLES, FIXTURES_DIR, loadFixtures, TASKS_PER_ROLE } from './fixtures';
import { scriptedVerdict, scriptFor } from './scripted';

const sets = loadFixtures();
const THRESHOLD = 85;

test('every role has at least 3 fixtures, with unique ids', () => {
  assert.deepEqual(sets.map((s) => s.role), [...EVAL_ROLES]);
  const ids = sets.flatMap((s) => s.tasks.map((t) => t.id));
  assert.equal(new Set(ids).size, ids.length, 'duplicate fixture id');
  for (const s of sets) assert.ok(s.tasks.length >= TASKS_PER_ROLE, `${s.role}: ${s.tasks.length} fixtures`);
});

test('work types belong to the role (review: to the maker) and have an SOP + QA checklist', () => {
  for (const s of sets) {
    for (const fx of s.tasks) {
      const owner = fx.kind === 'review' ? fx.maker : s.role;
      assert.ok(loadRole(owner).work_types.includes(fx.work_type), `${fx.id}: ${fx.work_type} is not a ${owner} work type`);
      for (const dir of ['sops', 'qa-checklists']) {
        assert.ok(fs.existsSync(path.join(config.brainDir, dir, `${fx.work_type}.md`)), `${fx.id}: brain/${dir}/${fx.work_type}.md missing`);
      }
      if (fx.kind === 'review') assert.equal(s.role, 'qa-lead', `${fx.id}: review fixtures are for qa-lead`);
      else assert.notEqual(s.role, 'qa-lead', `${fx.id}: qa-lead only has review fixtures`);
    }
  }
});

test('fixtures are fictional and branded RizeHub (never Yotomations); client sites use the reserved .example TLD', () => {
  for (const f of fs.readdirSync(FIXTURES_DIR)) {
    assert.doesNotMatch(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8'), /yotomations/i, f);
  }
  for (const fx of sets.flatMap((s) => s.tasks)) {
    if (fx.client?.website) assert.match(new URL(fx.client.website).hostname, /\.example$/, `${fx.id}: ${fx.client.website}`);
  }
});

test('scripts are consistent: the last attempt of a make fixture passes; review scripts match their expected verdict', () => {
  for (const fx of sets.flatMap((s) => s.tasks)) {
    const crit = fx.acceptance_criteria.length;
    if (fx.kind === 'review') {
      const passes = fx.scripted.qa.score >= THRESHOLD && fx.scripted.qa.fail.length === 0;
      assert.equal(passes ? 'pass' : 'fail', fx.expect, fx.id);
      continue;
    }
    const last = fx.scripted.attempts.at(-1)!;
    assert.ok(last.qa.score >= THRESHOLD && last.qa.fail.length === 0, `${fx.id}: last scripted attempt must pass`);
    for (const a of fx.scripted.attempts) for (const i of a.qa.fail) assert.ok(i < crit, `${fx.id}: fail index ${i} out of range`);
  }
});

test('scriptedVerdict is a valid QaVerdict with one check per criterion (verbatim)', () => {
  const crit = ['A', 'B', 'C'];
  const v = QaVerdict.parse(scriptedVerdict(crit, { score: 70, fail: [1] }));
  assert.equal(v.verdict, 'fail');
  assert.deepEqual(v.checks.map((c) => [c.criterion, c.result]), [['A', 'pass'], ['B', 'fail'], ['C', 'pass']]);
  assert.equal(v.fix_list.length, 1);
  assert.equal(QaVerdict.parse(scriptedVerdict(crit, { score: 90, fail: [] })).verdict, 'pass');
});

test('scriptFor clamps the attempt to the scripted list', () => {
  const fx = sets.find((s) => s.role === 'writer')!.tasks.find((t) => t.kind === 'make' && t.scripted.attempts.length === 2)!;
  assert.equal(scriptFor(fx, 1).qa.score, 71);
  assert.equal(scriptFor(fx, 2).qa.score, 92);
  assert.equal(scriptFor(fx, 9).qa.score, 92);
  assert.equal(scriptFor(fx, 0).qa.score, 71);
});
