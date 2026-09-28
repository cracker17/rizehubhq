import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessClientSlug, matchPlaybook, planNext, validatePlan } from './planner';
import { FakeHqDb } from './fakeHqDb';
import { jsonResponse, makeDeps, mockModel, promptText } from './testing';

const REQUEST = 'Write a blog post about Shopify speed for Madam Muse';

function plan(overrides: Record<string, unknown> = {}, taskOverrides: Record<string, unknown> = {}) {
  return {
    title: 'Madam Muse — Shopify speed article', client_slug: null, summary: 'One SEO article.',
    assumptions: ['Client is a Shopify store'], questions_for_ceo: [], due_date: null, priority: 'normal', estimated_cost_usd: 0.9,
    tasks: [{
      key: 'article', agent_id: 'seo-1', work_type: 'seo-article', title: 'Write Shopify speed article',
      instructions: 'Write a 1,200-word article on Shopify speed for Madam Muse.',
      acceptance_criteria: ['Primary keyword "shopify speed" in H1', 'Title ≤ 60 characters', 'Meta description ≤ 155 characters'],
      depends_on: [], ...taskOverrides,
    }],
    ...overrides,
  };
}

test('valid plan is submitted for CEO approval with usage logged', async () => {
  const db = new FakeHqDb();
  const req = db.addRequest({ raw_text: REQUEST, brief: { ceo_feedback: ['Make it 1,500 words'] } });
  const model = mockModel([jsonResponse(plan())]);
  const deps = makeDeps({ db, model });

  const out = await planNext(deps);
  assert.equal(out.status, 'submitted');
  assert.equal(db.requests.get(req.id)?.status, 'plan_review');
  assert.equal(db.callsOf('submitPlan').length, 1);
  assert.equal(db.callsOf('planningFailed').length, 0);
  assert.equal(db.approvals.find((a) => a.kind === 'plan')?.request_id, req.id);
  assert.equal(model.doGenerateCalls.length, 1);

  const text = promptText(model.doGenerateCalls[0]!);
  assert.match(text, /You are the COO of RizeHub/);           // role file
  assert.match(text, /routing:/);                              // roster.yaml
  assert.match(text, /- seo-1 \(/);                            // enabled agents
  assert.match(text, /Make it 1,500 words/);                   // CEO feedback
  assert.match(text, /brain\/playbooks\/client-work\.md/);    // playbook
  assert.equal(db.usage.length, 1);
  assert.equal(db.usage[0]?.kind, 'plan');
  assert.equal(db.usage[0]?.tokensIn, 100);
});

test('invalid plan is retried once with the validation error, then submitted', async () => {
  const db = new FakeHqDb();
  db.addRequest({ raw_text: REQUEST });
  const model = mockModel([jsonResponse(plan({}, { agent_id: 'nobody' })), jsonResponse(plan())]);
  const deps = makeDeps({ db, model });

  const out = await planNext(deps);
  assert.equal(out.status, 'submitted');
  assert.equal(out.status === 'submitted' && out.attempts, 2);
  assert.equal(model.doGenerateCalls.length, 2);
  assert.match(promptText(model.doGenerateCalls[1]!), /agent \\"nobody\\" is unknown or disabled/);
  assert.equal(db.usage[0]?.tokensIn, 200); // both calls counted
});

test('schema-invalid output twice → planning_failed', async () => {
  const db = new FakeHqDb();
  const req = db.addRequest({ raw_text: REQUEST });
  const badCriteria = plan({}, { acceptance_criteria: ['only one'] });           // < 3 criteria
  const model = mockModel([jsonResponse(badCriteria), jsonResponse('not json at all')]);
  const deps = makeDeps({ db, model });

  const out = await planNext(deps);
  assert.equal(out.status, 'failed');
  assert.equal(db.requests.get(req.id)?.status, 'failed');
  assert.equal(db.callsOf('submitPlan').length, 0);
  const ap = db.approvals.find((a) => a.payload.type === 'planning_failed');
  assert.ok(ap);
  assert.match(ap.title, /^COO couldn't plan this: /);
  assert.equal(db.callsOf('finishAgentTurn').at(-1)?.args[0], 'coo');
});

test('no staged request → idle, model never called', async () => {
  const model = mockModel([]);
  const out = await planNext(makeDeps({ model }));
  assert.equal(out.status, 'idle');
  assert.equal(model.doGenerateCalls.length, 0);
});

test('validatePlan rejects work types missing from the roster; helpers match playbooks and clients', () => {
  const v = validatePlan(plan({}, { work_type: 'telepathy' }), { enabledAgents: ['seo-1'], workTypes: ['seo-article'] });
  assert.equal(v.ok, false);
  assert.match(!v.ok ? v.error : '', /telepathy/);
  assert.equal(matchPlaybook('Find 30 Shopify stores in Australia and draft outreach'), 'lead-gen');
  assert.equal(matchPlaybook('Onboard Brisbane Coffee Co on shopify-growth'), 'onboarding');
  assert.equal(matchPlaybook(REQUEST), 'client-work');
  assert.equal(guessClientSlug(REQUEST, ['vinyl-icons', 'madam-muse']), 'madam-muse');
});
