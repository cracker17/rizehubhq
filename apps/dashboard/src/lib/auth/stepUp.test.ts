import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP_UP_MAX_AGE_SECONDS, approvalRisk, authGate, isStepUpError, lastTotpAt, needsTotpAtSignIn, normalizeTotp, ruleSaveNeed, safeNext, stepUpNeed,
} from './stepUp';

const NOW = 1_790_000_000;

test('approvalRisk: only outside-world action proposals are high-risk', () => {
  const action = (payload: Record<string, unknown>) => ({ kind: 'external_action', payload });
  assert.equal(approvalRisk(action({ type: 'external_action', action_type: 'merge_pr', spec: { description: 'Merge PR #12' } })), 'high');
  assert.equal(approvalRisk(action({ type: 'external_action', action_type: 'sales.email_batch' })), 'high');
  assert.equal(approvalRisk(action({ type: 'external_action', action_type: 'rizehub.report_publish', risk: 'Low · reversible' })), 'high', 'agent risk label never lowers it');
  for (const type of ['question', 'task_failed', 'qa_escalation', 'qa_stuck', 'planning_failed', 'vault_problem']) {
    assert.equal(approvalRisk(action({ type })), 'normal', type);
  }
  assert.equal(approvalRisk(action({ type: 'external_action', vault: { kind: '2fa' } })), 'normal', 'Vault 2FA code relay');
  assert.equal(approvalRisk({ kind: 'plan', payload: { type: 'external_action' } }), 'normal');
  assert.equal(approvalRisk({ kind: 'deliverable', payload: null }), 'normal');
});

test('lastTotpAt: latest TOTP entry of the amr claim; strings and other methods are ignored', () => {
  assert.equal(lastTotpAt([{ method: 'password', timestamp: NOW }, { method: 'totp', timestamp: NOW - 50 }, { method: 'totp', timestamp: NOW - 10 }]), NOW - 10);
  assert.equal(lastTotpAt([{ method: 'mfa/totp', timestamp: NOW - 3 }]), NOW - 3);
  assert.equal(lastTotpAt(['password', 'totp']), null);
  assert.equal(lastTotpAt([{ method: 'totp' }]), null);
  assert.equal(lastTotpAt(null), null);
});

test('stepUpNeed: approve + high-risk + enrolled needs a TOTP within 5 minutes', () => {
  const base = { decision: 'approve' as const, risk: 'high' as const, enrolled: true, nowSec: NOW };
  assert.equal(stepUpNeed({ ...base, totpAt: null }), 'required');
  assert.equal(stepUpNeed({ ...base, totpAt: NOW - 10 }), 'fresh');
  assert.equal(stepUpNeed({ ...base, totpAt: NOW - STEP_UP_MAX_AGE_SECONDS }), 'fresh');
  assert.equal(stepUpNeed({ ...base, totpAt: NOW - STEP_UP_MAX_AGE_SECONDS - 1 }), 'required');
  assert.equal(stepUpNeed({ ...base, totpAt: NOW + 3600 }), 'required', 'a timestamp from the future is not trusted');
  assert.equal(stepUpNeed({ ...base, decision: 'reject', totpAt: null }), 'not_needed');
  assert.equal(stepUpNeed({ ...base, decision: 'changes', totpAt: null }), 'not_needed');
  assert.equal(stepUpNeed({ ...base, risk: 'normal', totpAt: null }), 'not_needed');
  assert.equal(stepUpNeed({ ...base, enrolled: false, totpAt: null }), 'not_needed', 'no factor → nothing to step up with');
});

test('ruleSaveNeed: turning a rule on is step-up-protected, turning it off is not', () => {
  assert.equal(ruleSaveNeed({ enabled: true, enrolled: true, totpAt: null, nowSec: NOW }), 'required');
  assert.equal(ruleSaveNeed({ enabled: true, enrolled: true, totpAt: NOW - 5, nowSec: NOW }), 'fresh');
  assert.equal(ruleSaveNeed({ enabled: false, enrolled: true, totpAt: null, nowSec: NOW }), 'not_needed');
  assert.equal(ruleSaveNeed({ enabled: true, enrolled: false, totpAt: null, nowSec: NOW }), 'not_needed');
});

test('sign-in: a verified factor and an aal1 session means the TOTP step is still open', () => {
  assert.equal(needsTotpAtSignIn({ currentLevel: 'aal1', hasVerifiedFactor: true }), true);
  assert.equal(needsTotpAtSignIn({ currentLevel: null, hasVerifiedFactor: true }), true);
  assert.equal(needsTotpAtSignIn({ currentLevel: 'aal2', hasVerifiedFactor: true }), false);
  assert.equal(needsTotpAtSignIn({ currentLevel: 'aal1', hasVerifiedFactor: false }), false);
});

test('authGate: routing for signed-out, half-signed-in (TOTP pending) and signed-in sessions', () => {
  const g = (o: Partial<Parameters<typeof authGate>[0]>) => authGate({ signedIn: true, totpPending: false, path: '/', isPublic: false, step: null, ...o });
  assert.equal(g({ signedIn: false }), 'to_login');
  assert.equal(g({ signedIn: false, path: '/login', isPublic: true }), 'pass');
  assert.equal(g({ signedIn: false, path: '/access/abc', isPublic: true }), 'pass');
  assert.equal(g({ totpPending: true }), 'to_totp');
  assert.equal(g({ totpPending: true, path: '/approvals' }), 'to_totp');
  assert.equal(g({ totpPending: true, path: '/login', isPublic: true }), 'to_totp');
  assert.equal(g({ totpPending: true, path: '/login', isPublic: true, step: 'totp' }), 'pass');
  assert.equal(g({ totpPending: true, path: '/api/health', isPublic: true }), 'pass');
  assert.equal(g({ path: '/login', isPublic: true, step: 'totp' }), 'to_home');
  assert.equal(g({ path: '/settings' }), 'pass');
});

test('helpers: code normalisation, step-up errors, safe redirect targets', () => {
  assert.equal(normalizeTotp('482 913'), '482913');
  assert.equal(normalizeTotp('482-913'), '482913');
  assert.equal(normalizeTotp('48291'), null);
  assert.equal(normalizeTotp('abcdef'), null);
  assert.equal(normalizeTotp(undefined), null);
  assert.equal(isStepUpError('step_up_required: confirm with a fresh 2FA code in the dashboard'), true);
  assert.equal(isStepUpError('not allowed'), false);
  assert.equal(safeNext('/approvals?id=1'), '/approvals?id=1');
  assert.equal(safeNext('//evil.example'), '/');
  assert.equal(safeNext('/\\evil.example'), '/');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext(null), '/');
});
