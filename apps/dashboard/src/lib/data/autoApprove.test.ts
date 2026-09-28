// packages/shared/src/autoApprove.ts: the dashboard's mirror of the SQL auto-approve rules (the same scenarios are
// checked against the database in scripts/db-tests/110-totp-auto-approve.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_APPROVE_INTERNAL_WORK_TYPES, AutoApproveRuleInput, describeRule, evaluateAutoApprove, planAutoApproveBlocker, ruleMiss,
  type AutoApproveRule, type PlanForRules,
} from '@rizehubhq/shared';

const task = (key: string, work_type: string, over: Partial<NonNullable<PlanForRules['tasks']>[number]> = {}) => ({
  key, work_type, title: `${key} draft`, instructions: 'Write it in the brand voice.', acceptance_criteria: ['Keyword in H1', 'Under 900 words', 'Brand voice'], ...over,
});
const plan = (tasks = [task('a', 'seo-article')], over: Partial<PlanForRules> = {}): PlanForRules => ({
  title: 'Blog pack', summary: 'Three drafts for the blog queue', questions_for_ceo: [], estimated_cost_usd: 0.4, tasks, ...over,
});
const rule = (over: Partial<AutoApproveRule> = {}): AutoApproveRule => ({
  id: '00000000-0000-0000-0000-000000000001', name: 'Cheap drafts', enabled: true, max_cost_usd: '1.00', max_tasks: 3, work_types: [],
  client_scope: 'any', client_slugs: [], created_at: '2026-09-29T00:00:00Z', ...over,
});

test('default: no rules (or only disabled ones) never approves', () => {
  assert.deepEqual(evaluateAutoApprove([], plan(), null), { approve: false, reason: 'no auto-approve rules are on' });
  assert.equal(evaluateAutoApprove([rule({ enabled: false })], plan(), null).approve, false);
});

test('a cheap internal plan matches the first rule that covers it (oldest first)', () => {
  const late = rule({ id: '00000000-0000-0000-0000-000000000002', name: 'Later', created_at: '2026-09-30T00:00:00Z' });
  const v = evaluateAutoApprove([late, rule()], plan(), null);
  assert.equal(v.approve && v.rule.name, 'Cheap drafts');
});

test('hard guards: non-internal work, questions, missing cost and external wording block every rule', () => {
  assert.match(planAutoApproveBlocker(plan([task('a', 'seo-article'), task('b', 'shopify-page')]))!, /task b \(shopify-page\) is not internal-only work/);
  assert.match(planAutoApproveBlocker(plan([task('a', 'client-report')]))!, /not internal-only/, 'RizeHub report publishing');
  assert.match(planAutoApproveBlocker(plan([task('a', 'outreach-draft')]))!, /not internal-only/, 'feeds the outreach sender');
  assert.match(planAutoApproveBlocker(plan(undefined, { questions_for_ceo: ['Which keyword?'] }))!, /questions/);
  assert.match(planAutoApproveBlocker(plan(undefined, { estimated_cost_usd: null }))!, /no cost estimate/);
  assert.match(planAutoApproveBlocker(plan([]))!, /no tasks/);
  assert.match(planAutoApproveBlocker(plan([task('a', 'seo-article', { instructions: 'Write it, then publish it on the blog.' })]))!, /mentions "publish"/);
  assert.match(planAutoApproveBlocker(plan([task('a', 'dm-reply-draft', { acceptance_criteria: ['Sent to the lead'] })]))!, /mentions "Sent"/);
  assert.match(planAutoApproveBlocker(plan(undefined, { title: 'Deploy the new landing page' }))!, /plan mentions "Deploy"/);
  assert.match(planAutoApproveBlocker(plan([task('a', 'social-captions', { title: 'Captions to post on Instagram' })]))!, /"post on"/);
  assert.match(planAutoApproveBlocker(plan([task('a', 'meeting-prep', { instructions: 'Email it to the client' })]))!, /"Email it to"/);
  assert.equal(planAutoApproveBlocker(plan([task('a', 'seo-article', { instructions: 'Blog post draft; keep the unpublished theme notes.' })])), null,
    '"post" alone and "unpublished" are not external actions');
  const v = evaluateAutoApprove([rule({ max_cost_usd: 100, max_tasks: null })], plan([task('b', 'wordpress-page')]), null);
  assert.equal(v.approve, false);
});

test('rule limits: cost cap, task count, work types', () => {
  assert.match(ruleMiss(rule(), plan(undefined, { estimated_cost_usd: 1.5 }), null)!, /over \$1/);
  assert.equal(ruleMiss(rule(), plan(undefined, { estimated_cost_usd: 1 }), null), null, 'the cap is inclusive');
  assert.match(ruleMiss(rule(), plan(['a', 'b', 'c', 'd'].map((k) => task(k, 'seo-article'))), null)!, /4 tasks is over 3/);
  assert.equal(ruleMiss(rule({ max_tasks: null }), plan(['a', 'b', 'c', 'd'].map((k) => task(k, 'seo-article'))), null), null);
  assert.match(ruleMiss(rule({ work_types: ['seo-article'] }), plan([task('a', 'seo-article'), task('b', 'wireframe')]), null)!, /wireframe/);
});

test('client scope: any / none (internal only) / listed', () => {
  assert.equal(ruleMiss(rule({ client_scope: 'any' }), plan(), 'madam-muse'), null);
  assert.equal(ruleMiss(rule({ client_scope: 'any' }), plan(), null), null);
  assert.equal(ruleMiss(rule({ client_scope: 'none' }), plan(), null), null);
  assert.match(ruleMiss(rule({ client_scope: 'none' }), plan(), 'madam-muse')!, /internal requests only/);
  assert.equal(ruleMiss(rule({ client_scope: 'listed', client_slugs: ['madam-muse'] }), plan(), 'madam-muse'), null);
  assert.match(ruleMiss(rule({ client_scope: 'listed', client_slugs: ['madam-muse'] }), plan(), 'vinyl-icons')!, /not in the rule/);
  assert.match(ruleMiss(rule({ client_scope: 'listed', client_slugs: ['madam-muse'] }), plan(), null)!, /not in the rule/);
});

test('rule input validation (the form): internal work types only, listed needs clients, sane numbers', () => {
  const ok = AutoApproveRuleInput.safeParse({ name: ' Drafts ', max_cost_usd: 2, work_types: ['seo-article'], client_scope: 'none' });
  assert.equal(ok.success, true);
  if (ok.success) { assert.equal(ok.data.name, 'Drafts'); assert.equal(ok.data.enabled, true); assert.equal(ok.data.max_tasks, null); }
  assert.equal(AutoApproveRuleInput.safeParse({ name: 'x', max_cost_usd: 2, work_types: ['shopify-page'] }).success, false);
  assert.equal(AutoApproveRuleInput.safeParse({ name: 'x', max_cost_usd: 2, client_scope: 'listed', client_slugs: [] }).success, false);
  assert.equal(AutoApproveRuleInput.safeParse({ name: 'x', max_cost_usd: 500 }).success, false);
  assert.equal(AutoApproveRuleInput.safeParse({ name: '', max_cost_usd: 1 }).success, false);
  assert.equal(AutoApproveRuleInput.safeParse({ name: 'x', max_cost_usd: 1, client_scope: 'listed', client_slugs: ['Bad Slug'] }).success, false);
});

test('internal work types never include developer or publishing work; rules describe themselves', () => {
  for (const wt of ['shopify-page', 'webflow-cms', 'wordpress-page', 'web-app', 'client-report', 'client-onboarding', 'workspace-setup',
    'access-checklist', 'lead-finder-search', 'outreach-draft', 'follow-up-email', 'proposal']) {
    assert.equal((AUTO_APPROVE_INTERNAL_WORK_TYPES as readonly string[]).includes(wt), false, wt);
  }
  assert.equal(describeRule(rule({ work_types: ['seo-article', 'meta-tags'], client_scope: 'none' })),
    '≤ $1.00 est. · ≤ 3 tasks · seo-article, meta-tags · no client (internal)');
  assert.equal(describeRule(rule({ max_tasks: null, client_scope: 'listed', client_slugs: ['madam-muse'] })),
    '≤ $1.00 est. · any internal work type · clients: madam-muse');
});
