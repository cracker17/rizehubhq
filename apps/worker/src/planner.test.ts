import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceDesignHandoff, guessClientSlug, matchPlaybook, planNext, validatePlan } from './planner';
import { Plan } from '@rizehubhq/shared';
import { FakeHqDb } from './fakeHqDb';
import { jsonResponse, makeDeps, mockModel, promptText } from './testing';

const REQUEST = 'Write a blog post about Shopify speed for Madam Muse';

function plan(overrides: Record<string, unknown> = {}, taskOverrides: Record<string, unknown> = {}) {
  return {
    title: 'Madam Muse — Shopify speed article', client_slug: null, summary: 'One SEO article.',
    assumptions: ['Client is a Shopify store'], questions_for_ceo: [], due_date: null, priority: 'normal', estimated_cost_usd: 0.9,
    tasks: [{
      key: 'article', agent_id: 'writer', work_type: 'seo-article', title: 'Write Shopify speed article',
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
  assert.match(text, /- writer \(/);                            // enabled agents
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
  const v = validatePlan(plan({}, { work_type: 'telepathy' }), { enabledAgents: ['writer'], workTypes: ['seo-article'] });
  assert.equal(v.ok, false);
  assert.match(!v.ok ? v.error : '', /telepathy/);
  assert.equal(matchPlaybook('Find 30 Shopify stores in Australia and draft outreach'), 'lead-gen');
  assert.equal(matchPlaybook('Onboard Brisbane Coffee Co on shopify-growth'), 'onboarding');
  assert.equal(matchPlaybook(REQUEST), 'client-work');
  assert.equal(guessClientSlug(REQUEST, ['vinyl-icons', 'madam-muse']), 'madam-muse');
});

// ---------- design → dev handoff ----------
const T = (key: string, agent_id: string, work_type: string, depends_on: string[] = []) => ({
  key, agent_id, work_type, title: `${key} task`, instructions: 'do it', acceptance_criteria: ['a', 'b', 'c'], depends_on,
});
const handoffPlan = (tasks: ReturnType<typeof T>[]) => Plan.parse(plan({ title: 'Bundle page', tasks }));

test('enforceDesignHandoff: dev tasks without a design dependency get one; existing (transitive) ones are kept', () => {
  const p = handoffPlan([T('copy', 'writer', 'landing-copy'), T('mock', 'designer', 'ui-mockup', ['copy']), T('build', 'web-dev', 'shopify-section'), T('qa-copy', 'writer', 'meta-tags')]);
  const { plan: fixed, added } = enforceDesignHandoff(p);
  assert.deepEqual(added, [{ task: 'build', design: 'mock' }]);
  assert.deepEqual(fixed.tasks.find((t) => t.key === 'build')!.depends_on, ['mock']);
  assert.deepEqual(fixed.tasks.find((t) => t.key === 'qa-copy')!.depends_on, [], 'non-dev tasks untouched');
  assert.match(fixed.assumptions.at(-1)!, /Task build waits for design task mock: it starts after the design is QA-passed and approved/);
  assert.deepEqual(p.tasks.find((t) => t.key === 'build')!.depends_on, [], 'input plan not mutated');
  assert.ok(Plan.safeParse(fixed).success, 'still a valid plan');

  // already waits for the design through another dev task → nothing added
  const chained = handoffPlan([T('mock', 'designer', 'wireframe'), T('cms', 'web-dev', 'webflow-cms', ['mock']), T('page', 'web-dev', 'webflow-page', ['cms'])]);
  assert.deepEqual(enforceDesignHandoff(chained).added, []);
});

test('enforceDesignHandoff: no layout design (ad creatives only) or no dev task → plan unchanged; never creates a cycle', () => {
  const ads = handoffPlan([T('ads', 'designer', 'ad-creative'), T('build', 'web-dev', 'shopify-section')]);
  assert.equal(enforceDesignHandoff(ads).plan, ads);
  const noDev = handoffPlan([T('mock', 'designer', 'ui-mockup'), T('copy', 'writer', 'landing-copy')]);
  assert.deepEqual(enforceDesignHandoff(noDev).added, []);
  // a UX audit of what the developer builds first: the audit already depends on the dev task, so no reverse edge
  const audit = handoffPlan([T('build', 'web-dev', 'shopify-section'), T('audit', 'designer', 'ux-audit', ['build'])]);
  assert.deepEqual(enforceDesignHandoff(audit).added, []);
});

test('planner: the COO prompt carries the handoff rule and a submitted plan makes dev wait for design', async () => {
  const db = new FakeHqDb();
  db.addRequest({ raw_text: 'Design and build a bundle page for Madam Muse' });
  const model = mockModel([jsonResponse(plan({ tasks: [T('mock', 'designer', 'ui-mockup'), T('build', 'web-dev', 'shopify-section')] }))]);
  const deps = makeDeps({ db, model });
  assert.equal((await planNext(deps)).status, 'submitted');
  assert.match(promptText(model.doGenerateCalls[0]!), /Design → dev handoff: .*put its key in depends_on of every web-dev task/);
  const submitted = db.callsOf('submitPlan')[0]!.args[1] as Plan;
  assert.deepEqual(submitted.tasks.find((t) => t.key === 'build')!.depends_on, ['mock']);
  assert.ok(deps.logs.some((l) => l.includes('design → dev handoff: build waits for mock')));
});

test('planner: Anthropic gets the COO system prompt as a cached system message (prompt caching)', async () => {
  const db = new FakeHqDb();
  db.addRequest({ raw_text: REQUEST });
  const model = mockModel([jsonResponse(plan())]);
  await planNext(makeDeps({ db, model, provider: 'anthropic', modelId: 'claude-sonnet-5' }));
  const sys = model.doGenerateCalls[0]!.prompt[0]!;
  assert.equal(sys.role, 'system');
  assert.deepEqual(sys.providerOptions?.anthropic, { cacheControl: { type: 'ephemeral' } });
});

test('free models only (MONTHLY_BUDGET_USD=0): the plan estimate is $0, whatever the model guessed', async () => {
  const db = new FakeHqDb();
  db.addRequest({ raw_text: REQUEST });
  const deps = { ...makeDeps({ db, model: mockModel([jsonResponse(plan({ estimated_cost_usd: 2 }))]) }), monthlyBudgetUsd: 0 };
  assert.equal((await planNext(deps)).status, 'submitted');
  assert.equal(db.approvals.find((a) => a.kind === 'plan')?.payload.estimated_cost_usd, 0);

  const db2 = new FakeHqDb();
  db2.addRequest({ raw_text: REQUEST });
  const paid = { ...makeDeps({ db: db2, model: mockModel([jsonResponse(plan({ estimated_cost_usd: 2 }))]) }), monthlyBudgetUsd: 50 };
  await planNext(paid);
  assert.equal(db2.approvals.find((a) => a.kind === 'plan')?.payload.estimated_cost_usd, 2);
});
