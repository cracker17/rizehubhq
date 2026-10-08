import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ceoEmailNeedsStepUp, isEmailAddress, parseCeoEmailSettings } from '@rizehubhq/shared';
import { ceoEmailDirty, ceoEmailProblem, ceoEmailSaveNeedsCode, initialCeoEmailForm, type GmailOption } from './ceoEmailForm';

const A = '11111111-2222-4333-8444-555555555555';
const B = '11111111-2222-4333-8444-666666666666';
const gmail: GmailOption[] = [{ id: A, email: 'old@gmail.com', status: 'needs_reauth' }, { id: B, email: 'hq@gmail.com', status: 'active' }];

test('parseCeoEmailSettings: anything malformed falls back to off with default events (plans off)', () => {
  const off = parseCeoEmailSettings(null);
  assert.equal(off.enabled, false);
  assert.deepEqual(off.events, { results: true, questions: true, failures: true, plans: false });
  const s = parseCeoEmailSettings({ enabled: 'yes', connector_id: 'x', to: 'Boss <b@x.com>', events: { plans: true, results: 'no' }, enabled_at: 'nope' });
  assert.deepEqual(s, { enabled: false, connector_id: null, to: null, events: { results: true, questions: true, failures: true, plans: true }, enabled_at: null });
  assert.equal(parseCeoEmailSettings({ to: ' CEO@Example.COM ' }).to, 'ceo@example.com');
});

test('isEmailAddress: one plain address only', () => {
  for (const ok of ['a@b.co', 'talentedhand10@gmail.com', 'first.last+hq@sub.example.ph']) assert.equal(isEmailAddress(ok), true, ok);
  for (const bad of ['', 'a@b', 'a b@c.com', 'A <a@b.com>', 'a@b.com,c@d.com', 'a@b.com\nBcc: x@y.com', 'a@-b.com', `${'a'.repeat(250)}@b.com`]) {
    assert.equal(isEmailAddress(bad), false, bad);
  }
});

test('form defaults: the saved account and address, else the first ACTIVE account and its address', () => {
  const fresh = initialCeoEmailForm(parseCeoEmailSettings(null), gmail);
  assert.deepEqual(fresh, { enabled: false, connectorId: B, to: 'hq@gmail.com', events: { results: true, questions: true, failures: true, plans: false } });
  const saved = initialCeoEmailForm(parseCeoEmailSettings({ enabled: true, connector_id: A, to: 'ceo@example.com' }), gmail);
  assert.equal(saved.connectorId, A);
  assert.equal(saved.to, 'ceo@example.com');
  assert.equal(initialCeoEmailForm(parseCeoEmailSettings(null), []).connectorId, '');
});

test('problems: off may be saved half-filled; on needs an active account, an address and one event', () => {
  const base = { enabled: true, connectorId: B, to: 'ceo@example.com', events: { results: true, questions: false, failures: false, plans: false } };
  assert.equal(ceoEmailProblem(base, gmail), null);
  assert.equal(ceoEmailProblem({ ...base, enabled: false, connectorId: '', to: '' }, gmail), null);
  assert.match(ceoEmailProblem({ ...base, to: 'nope' }, gmail)!, /one email address/);
  assert.match(ceoEmailProblem({ ...base, connectorId: A }, gmail)!, /not active/);
  assert.match(ceoEmailProblem({ ...base, connectorId: '' }, gmail)!, /Pick a Gmail account/);
  assert.match(ceoEmailProblem({ ...base, to: '' }, gmail)!, /address to send to/);
  assert.match(ceoEmailProblem({ ...base, events: { results: false, questions: false, failures: false, plans: false } }, gmail)!, /at least one/);
});

test('2FA: a new address or turning it on asks for the code; events, account and turning off do not', () => {
  const saved = parseCeoEmailSettings({ enabled: true, connector_id: B, to: 'ceo@example.com', enabled_at: '2026-10-09T00:00:00Z' });
  const f = initialCeoEmailForm(saved, gmail);
  assert.equal(ceoEmailSaveNeedsCode(saved, f), false);
  assert.equal(ceoEmailSaveNeedsCode(saved, { ...f, to: 'CEO@example.com ' }), false, 'same address, other case');
  assert.equal(ceoEmailSaveNeedsCode(saved, { ...f, to: 'other@example.com' }), true);
  assert.equal(ceoEmailSaveNeedsCode(saved, { ...f, events: { ...f.events, plans: true } }), false);
  assert.equal(ceoEmailSaveNeedsCode(saved, { ...f, enabled: false }), false);
  const off = parseCeoEmailSettings({ ...saved, enabled: false });
  assert.equal(ceoEmailSaveNeedsCode(off, { ...f, enabled: true }), true);
  assert.equal(ceoEmailNeedsStepUp(off, { enabled: false, to: 'ceo@example.com' }), false);
});

test('dirty: only real changes count', () => {
  const saved = parseCeoEmailSettings({ enabled: true, connector_id: B, to: 'ceo@example.com', enabled_at: '2026-10-09T00:00:00Z' });
  const f = initialCeoEmailForm(saved, gmail);
  assert.equal(ceoEmailDirty(saved, f), false);
  assert.equal(ceoEmailDirty(saved, { ...f, to: ' CEO@example.com' }), false);
  assert.equal(ceoEmailDirty(saved, { ...f, events: { ...f.events, plans: true } }), true);
  assert.equal(ceoEmailDirty(saved, { ...f, enabled: false }), true);
});
