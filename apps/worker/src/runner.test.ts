import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APICallError } from 'ai';
import { buildTaskPrompt, buildTools, externalActionSpec, runTask } from './runner';
import { FakeHqDb } from './fakeHqDb';
import { loadRole } from './roles';
import { makeDeps, mockModel, promptText, textResponse, toolCalls } from './testing';
import type { TaskOutput } from './hqdb';

const CRITERIA = ['H1 contains "shopify speed"', 'Title ≤ 60 characters', 'At least 3 internal links'];

function setup() {
  const db = new FakeHqDb();
  const task = db.addTask({ agent_id: 'writer', title: 'Shopify speed article', acceptance_criteria: CRITERIA });
  db.tasks.get(task.id)!.status = 'working';
  return { db, task: { ...task, status: 'working' as const } };
}

test('tool calls → report_progress + submit_output recorded; run stops after submit', async () => {
  const { db, task } = setup();
  const model = mockModel([
    toolCalls([{ name: 'report_progress', input: { percent: 50, note: 'Drafting', app: 'doc', title: 'article.md', content: '# Shopify speed' } }]),
    toolCalls([{ name: 'submit_output', input: {
      summary: '1,200-word article', content: '# Shopify speed\n...', links: ['https://example.com'],
      criteria_map: CRITERIA.map((c) => ({ criterion: c, how_met: 'yes' })),
    } }]),
    textResponse('should never be requested'),
  ]);
  const deps = makeDeps({ db, model });
  const r = await runTask(task, deps, { heartbeatMs: 5 });

  assert.equal(r.status, 'submitted');
  assert.equal(model.doGenerateCalls.length, 2);
  const progress = db.callsOf('reportProgress');
  assert.equal(progress.length, 2); // initial "Reading the brief" + agent's own
  assert.equal(progress[1]?.args[2], 'Drafting');
  assert.equal(db.screens.get('writer')?.title, 'article.md');
  const out = db.tasks.get(task.id)!.output as unknown as TaskOutput;
  assert.equal(out.summary, '1,200-word article');
  assert.equal(out.criteria_map[CRITERIA[0]!], 'yes');
  assert.equal(db.tasks.get(task.id)!.status, 'qa_pending');
  assert.equal(db.usage.length, 1);
  assert.equal(db.usage[0]?.kind, 'task');
  assert.equal(db.usage[0]?.tokensIn, 200);
  assert.equal(db.callsOf('finishAgentTurn').at(-1)?.args[0], 'writer');

  // the model saw exactly the role's tools, the task prompt, and the role as system prompt
  const call = model.doGenerateCalls[0]!;
  const names = (call.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(names, [...loadRole('writer').tools].sort());
  assert.match(promptText(call), /You are RizeHub's Content Writer/);
  assert.match(promptText(call), /At least 3 internal links/);
});

test('tools not built yet are stubs that tell the agent to degrade gracefully', async () => {
  const { db, task } = setup();
  const role = { ...loadRole('writer'), tools: [...loadRole('writer').tools, 'future_tool'] };
  const tools = buildTools({ task, role, deps: makeDeps({ db, model: mockModel([]) }), state: { ended: null, costUsd: 0, overBudget: false, toolErrors: 0 } });
  const exec = tools.future_tool?.execute as ((input: unknown, opts: unknown) => Promise<string>) | undefined;
  assert.ok(exec, 'unknown tool is registered as a stub');
  const msg = await exec({ request: 'x' }, { toolCallId: 't1', messages: [] });
  assert.match(msg, /Tool "future_tool" is not connected yet/);
});

test('every tool named in a role file has a real implementation', () => {
  const { db, task } = setup();
  const deps = makeDeps({ db, model: mockModel([]) });
  const known = new Set(['create_plan', 'qa_submit_verdict']); // handled outside task runs (planner / QA)
  for (const id of ['coo', 'web-dev', 'designer', 'writer', 'sales', 'qa-lead']) {
    const role = loadRole(id);
    const tools = buildTools({ task, role, deps, state: { ended: null, costUsd: 0, overBudget: false, toolErrors: 0 } });
    for (const name of role.tools) {
      if (known.has(name)) continue;
      assert.ok(!String(tools[name]?.description ?? '').includes('(not connected yet)'), `${id}: ${name} is still a stub`);
    }
  }
});

test('model ends without submit_output → final text saved as output', async () => {
  const { db, task } = setup();
  const model = mockModel([textResponse('# Shopify speed\n\nHere is the full article text.')]);
  const r = await runTask(task, makeDeps({ db, model }));
  assert.deepEqual(r.status === 'submitted' && r.fallback, true);
  const out = db.tasks.get(task.id)!.output as unknown as TaskOutput;
  assert.equal(out.fallback, true);
  assert.match(out.content ?? '', /full article text/);
  assert.equal(db.tasks.get(task.id)!.status, 'qa_pending');
});

test('budget exceeded → run stops and the task fails', async () => {
  const { db, task } = setup();
  // 1M input tokens on Opus = $4 > the writer's budget $0.90
  const model = mockModel([
    toolCalls([{ name: 'report_progress', input: { percent: 10, note: 'Reading' } }], { inputTokens: 1_000_000, outputTokens: 10 }),
    toolCalls([{ name: 'submit_output', input: { summary: 'too late' } }]),
  ]);
  const deps = makeDeps({ db, model, provider: 'anthropic', modelId: 'claude-opus-5-5' });
  const r = await runTask(task, deps);
  assert.equal(r.status, 'budget_exceeded');
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(db.tasks.get(task.id)!.status, 'failed');
  assert.match(String(db.callsOf('failTask')[0]?.args[1]), /^stopped: exceeded \$0\.90 task budget \(\$4\.0\d+ spent\)$/);
  assert.ok((db.usage[0]?.costUsd ?? 0) > 4);
});

test('ask_ceo pauses the task; request_external_action only queues an approval', async () => {
  const { db, task } = setup();
  const model = mockModel([
    toolCalls([{ name: 'request_external_action', input: { type: 'publish_article', spec: 'Publish on madammuse.co/blogs' } }]),
    toolCalls([{ name: 'ask_ceo', input: { question: 'Which products should the article link to?' } }]),
  ]);
  const r = await runTask(task, makeDeps({ db, model }));
  assert.equal(r.status, 'asked_ceo');
  assert.equal(db.tasks.get(task.id)!.status, 'awaiting_ceo');
  assert.equal(db.approvals.filter((a) => a.payload.type === 'external_action').length, 1);
  assert.match(promptText(model.doGenerateCalls[1]!), /queued for CEO approval/i);
});

test('request_external_action: types without a worker executor are marked manual and the agent is told the CEO does it', async () => {
  const { db, task } = setup();
  const model = mockModel([
    toolCalls([{ name: 'request_external_action', input: { type: 'merge_pr', spec: 'Merge acme/theme#7 into main' } }]),
    toolCalls([{ name: 'request_external_action', input: { type: 'rizehub.report_publish', spec: 'Publish report r1' } }]),
    toolCalls([{ name: 'ask_ceo', input: { question: 'ok?' } }]),
  ]);
  await runTask(task, makeDeps({ db, model }));
  const actions = db.approvals.filter((a) => a.payload.type === 'external_action');
  assert.equal(actions.length, 1, 'rizehub.* is refused here (its own tool builds the executable payload)');
  assert.deepEqual((actions[0]!.payload as { spec: unknown }).spec, { description: 'Merge acme/theme#7 into main', executor: 'manual' });
  assert.match(promptText(model.doGenerateCalls[1]!), /MANUAL action: nothing runs automatically after approval/);
  assert.match(promptText(model.doGenerateCalls[2]!), /Not queued: \\?"rizehub\.report_publish\\?" is executed by the worker/);
  assert.deepEqual(externalActionSpec('rizehub.invite_send', 'x'), { description: 'x', executor: 'worker' });
});

test('provider 429 → task re-queued, not failed', async () => {
  const { db, task } = setup();
  const err = new APICallError({ message: 'Too Many Requests', url: 'https://x', requestBodyValues: {}, statusCode: 429, isRetryable: false });
  const deps = makeDeps({ db, model: mockModel({ error: err }) });
  const r = await runTask(task, deps);
  assert.equal(r.status, 'requeued');
  assert.equal(db.tasks.get(task.id)!.status, 'queued');
  assert.equal(db.callsOf('failTask').length, 0);
  assert.deepEqual(deps.quotaHits, ['google']);
});

test('revision prompt carries QA feedback and the previous output', () => {
  const db = new FakeHqDb();
  const task = db.addTask({
    agent_id: 'writer', revision_count: 1, output: { summary: 'v1' },
    qa_feedback: { source: 'qa', fix_list: ['Shorten the title'], failed_checks: [{ criterion: 'Title ≤ 60 characters', note: '72 chars' }] },
  });
  const text = buildTaskPrompt(task, null, makeDeps({ db, model: mockModel([]) }));
  assert.match(text, /Shorten the title/);
  assert.match(text, /Title ≤ 60 characters: 72 chars/);
  assert.match(text, /"summary":"v1"/);
  assert.match(text, /brain\/sops\/seo-article\.md/);
});

test('Anthropic: system prompt + tools cached once, conversation cached per step; cache writes/reads priced', async () => {
  const { db, task } = setup();
  const withCache = (r: ReturnType<typeof toolCalls>, write: number, read: number) => ({
    ...r, usage: { ...r.usage, inputTokens: 1_000, cachedInputTokens: read }, providerMetadata: { anthropic: { cacheCreationInputTokens: write } },
  });
  const model = mockModel([
    withCache(toolCalls([{ name: 'report_progress', input: { percent: 50, note: 'Drafting' } }]), 10_000, 0),
    withCache(toolCalls([{ name: 'submit_output', input: { summary: 'done', content: 'x' } }]), 500, 10_000),
  ]);
  const r = await runTask(task, makeDeps({ db, model, provider: 'anthropic', modelId: 'claude-sonnet-5' }));
  assert.equal(r.status, 'submitted');
  const [first, second] = model.doGenerateCalls;
  const sys = first!.prompt[0]!;
  assert.equal(sys.role, 'system');
  assert.deepEqual(sys.providerOptions?.anthropic, { cacheControl: { type: 'ephemeral' } });
  assert.deepEqual(first!.prompt.at(-1)!.providerOptions?.anthropic, { cacheControl: { type: 'ephemeral' } });
  assert.equal(second!.prompt[0]!.role, 'system');
  assert.deepEqual(second!.prompt.at(-1)!.providerOptions?.anthropic, { cacheControl: { type: 'ephemeral' } }, 'newest message marked on step 2');
  assert.equal(second!.prompt.filter((m) => m.providerOptions?.anthropic).length, 2, 'system + one rolling breakpoint');
  // step 1: 1k fresh ($0.002) + 10k write ($0.025) + 50 out ($0.0005); step 2: 1k fresh + 500 write ($0.00125) + 10k read ($0.002) + 50 out
  const u = db.usage[0]!;
  assert.equal(u.tokensIn, 1_000 + 10_000 + 1_000 + 500 + 10_000);
  assert.equal(u.detail.cache_write_in, 10_500);
  assert.equal(u.detail.cached_in, 10_000);
  assert.ok(Math.abs(u.costUsd - (0.0275 + 0.00575)) < 1e-9, `cost ${u.costUsd}`);
});

test('other providers get the plain system prompt (no cache options)', async () => {
  const { db, task } = setup();
  const model = mockModel([toolCalls([{ name: 'submit_output', input: { summary: 'done' } }])]);
  await runTask(task, makeDeps({ db, model, provider: 'openai', modelId: 'gpt-5.5' }));
  assert.ok(model.doGenerateCalls[0]!.prompt.every((m) => !m.providerOptions?.anthropic));
});

test('max steps: the loop stops at the role\'s max_turns and the task fails with an explicit reason', async () => {
  const { db, task } = setup();
  const step = () => toolCalls([{ name: 'report_progress', input: { percent: 10, note: 'Still going' } }]);
  const model = mockModel([step(), step(), step(), step()]);
  const deps = makeDeps({ db, model });
  const r = await runTask(task, { ...deps, loadRole: (id) => ({ ...loadRole(id), max_turns: 3 }) });
  assert.deepEqual(r.status === 'failed' && r.reason, 'stopped: exceeded max steps 3');
  assert.equal(model.doGenerateCalls.length, 3);
  assert.equal(db.tasks.get(task.id)!.status, 'failed');
  assert.equal(db.callsOf('failTask')[0]?.args[1], 'stopped: exceeded max steps 3');
});
