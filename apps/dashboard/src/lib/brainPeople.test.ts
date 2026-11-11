import test from 'node:test';
import assert from 'node:assert/strict';
import { draftOf, grantsPayload, inviteMessage, joinUrl, levelOf, personStatus, sameDraft, setLevel, setRole, type BrainPerson } from './brainPeople';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const person = (p: Partial<BrainPerson> = {}): BrainPerson => ({
  id: 'p', email: 'ana@example.com', name: 'Ana Cruz', title: null, role: 'member', invited_at: '2026-11-10T00:00:00Z',
  invite_expires_at: '2026-11-17T00:00:00Z', joined_at: null, disabled_at: null, grants: [], last_active_at: null, connections: 0, ...p,
});

test('status in words', () => {
  assert.equal(personStatus(person(), NOW).label, 'Invited');
  assert.equal(personStatus(person({ invite_expires_at: '2026-11-01T00:00:00Z' }), NOW).label, 'Invite expired');
  assert.equal(personStatus(person({ joined_at: '2026-11-10T00:00:00Z' }), NOW).label, 'Joined');
  assert.equal(personStatus(person({ joined_at: '2026-11-10T00:00:00Z', connections: 1 }), NOW).label, 'Connected');
  assert.equal(personStatus(person({ disabled_at: '2026-11-11T00:00:00Z' }), NOW).label, 'Disabled');
});

test('draft editing: none removes, viewers are read-only, payload round-trips', () => {
  let d = draftOf(person({ grants: [{ slug: 'alpha', access: 'write', transcripts: true, expires_at: null }] }));
  assert.equal(levelOf(d, 'alpha'), 'write');
  d = setLevel(d, 'beta', 'read');
  assert.deepEqual(grantsPayload(d).map((g) => g.slug).sort(), ['alpha', 'beta']);
  assert.equal(d.grants.alpha!.transcripts, true, 'options survive a level change');
  d = setLevel(d, 'alpha', 'none');
  assert.equal(levelOf(d, 'alpha'), 'none');
  d = setRole(setLevel(d, 'beta', 'write'), 'viewer');
  assert.equal(levelOf(d, 'beta'), 'read');
  assert.equal(levelOf(setLevel(d, 'gamma', 'write'), 'gamma'), 'read');
  assert.ok(sameDraft(d, { ...d }));
});

test('invite link and message', () => {
  const url = joinUrl('a'.repeat(40));
  assert.equal(url, `https://hq.rizehub.ph/join/${'a'.repeat(40)}`);
  assert.match(inviteMessage('Ana Cruz', url), /^Hi Ana, .*7 days/);
});
