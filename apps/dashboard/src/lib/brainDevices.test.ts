import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceHealth, installProgress, roundTripStages, setupCommand, staleConnection, stepsFor, type BrainDevice } from './brainDevices';
import { demoDevices } from './data/brainDemo';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const t = (min: number) => new Date(NOW - min * 60_000).toISOString();
const pc = (p: Partial<BrainDevice> = {}): BrainDevice => ({
  id: 'd', name: 'PC', kind: 'pc', owner_label: 'Julev', track: 'owner', setup_expires_at: t(-20), setup_used_at: t(5),
  checklist: {}, info: {}, roundtrip: {}, created_at: t(10), last_seen_at: null, last_pull_at: null, last_push_at: null,
  last_sync_error: null, ready_at: null, revoked_at: null, connected_at: null, tested_at: null, ...p,
});

test('members never see the Git step', () => {
  assert.ok(stepsFor('owner').some((s) => s.id === 'git'));
  assert.ok(!stepsFor('member').some((s) => s.id === 'git'));
});

test('progress counts done and skipped steps and finds the first failure', () => {
  const d = pc({ checklist: { claude: { s: 'done' }, ps: { s: 'done' }, git: { s: 'fail', detail: 'download timed out' }, python: { s: 'skip' } } });
  const p = installProgress(d);
  assert.equal(p.done, 3);
  assert.equal(p.failed?.id, 'git');
  assert.equal(p.allDone, false);
});

test('health reads like a sentence and follows sync age', () => {
  assert.deepEqual(deviceHealth(pc({ setup_used_at: null }), NOW).label, 'Waiting');
  assert.equal(deviceHealth(pc({ setup_used_at: null, setup_expires_at: t(1) }), NOW).label, 'Link expired');
  const failed = deviceHealth(pc({ checklist: { git: { s: 'fail', detail: 'download timed out' } } }), NOW);
  assert.equal(failed.level, 'bad');
  assert.match(failed.why, /Git for Windows: download timed out/);
  const ready = { ready_at: t(60) };
  assert.equal(deviceHealth(pc({ ...ready, last_pull_at: t(5), last_push_at: t(6) }), NOW).level, 'ok');
  assert.equal(deviceHealth(pc({ ...ready, last_pull_at: t(45) }), NOW).label, 'Behind');
  assert.equal(deviceHealth(pc({ ...ready, last_pull_at: t(60 * 30) }), NOW).label, 'Not syncing');
  assert.equal(deviceHealth(pc({ ...ready, last_pull_at: t(5), last_sync_error: 'push failed', last_seen_at: t(5) }), NOW).label, 'Sync problem');
  assert.equal(deviceHealth({ ...pc(), kind: 'claude', tested_at: t(3) }, NOW).label, 'Connected');
});

test('round trip shows seconds from the written note', () => {
  const s = roundTripStages({ roundtrip: { written_at: '2026-11-11T10:00:00Z', pushed_at: '2026-11-11T10:00:04Z', indexed_at: '2026-11-11T10:00:19Z' } });
  assert.deepEqual(s.map((x) => x.seconds), [0, 4, 19, null]);
});

test('a never-used approval older than a week is flagged', () => {
  const c = { family_id: 'f', client_id: null, client_name: 'Claude Code', redirect_uris: [], subject: 'ceo', scopes: [], approved_at: t(60 * 24 * 31), last_used_at: null, expires_at: t(-1) };
  assert.equal(staleConnection(c, NOW), true);
  assert.equal(staleConnection({ ...c, last_used_at: t(5) }, NOW), false);
});

test('setup command and demo devices', () => {
  assert.equal(setupCommand('0123456789abcdef0123'), 'irm https://hq.rizehub.ph/setup/0123456789abcdef0123 | iex');
  assert.equal(demoDevices(NOW).length, 3);
  assert.equal(deviceHealth(demoDevices(NOW)[0], NOW).level, 'ok');
});
