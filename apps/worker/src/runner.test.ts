import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APICallError } from 'ai';
import { buildTaskPrompt, runTask } from './runner';
import { FakeHqDb } from './fakeHqDb';
import { loadRole } from './roles';
import { makeDeps, mockModel, promptText, textResponse, toolCalls } from './testing';
import type { TaskOutput } from './hqdb';

const CRITERIA = ['H1 contains "shopify speed"', 'Title ≤ 60 characters', 'At least 3 internal links'];

function setup() {
  const db = new FakeHqDb();
  const task = db.addTask({ agent_id: 'seo-1', title: 'Shopify speed article', acceptance_criteria: CRITERIA });
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
  assert.equal(db.screens.get('seo-1')?.title, 'article.md');
  const out = db.tasks.get(task.id)!.output as unknown as TaskOutput;
  assert.equal(out.summary, '1,200-word article');
  assert.equal(out.criteria_map[CRITERIA[0]!], 'yes');
  assert.equal(db.tasks.get(task.id)!.status, 'qa_pending');
  assert.equal(db.usage.length, 1);
  assert.equal(db.usage[0]?.kind, 'task');
  assert.equal(db.usage[0]?.tokensIn, 200);
  assert.equal(db.callsOf('finishAgentTurn').at(-1)?.args[0], 'seo-1');

  // the model saw exactly the role's tools, the task prompt, and the role as system prompt
  const call = model.doGenerateCalls[0]!;
  const names = (call.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(names, [...loadRole('seo-1').tools].sort());
  assert.match(promptText(call), /SEO Content Writer 1/);
  assert.match(promptText(call), /At least 3 internal links/);
});

test('tools not built yet are stubs that tell the agent to degrade gracefully', async () => {
  const { db, task } = setup();
  const model = mockModel([
    toolCalls([{ name: 'semrush', input: { request: 'keyword volume for shopify speed' } }]),
    toolCalls([{ name: 'submit_output', input: { summary: 'done without semrush' } }]),
  ]);
  const r = await runTask(task, makeDeps({ db, model }));
  assert.equal(r.status, 'submitted');
  assert.match(promptText(model.doGenerateCalls[1]!), /Tool \\"semrush\\" is not connected yet \(milestone M10\)/);
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
  // 1M input tokens on Opus = $4 > seo-1 budget $0.90
  const model = mockModel([
    toolCalls([{ name: 'report_progress', input: { percent: 10, note: 'Reading' } }], { inputTokens: 1_000_000, outputTokens: 10 }),
    toolCalls([{ name: 'submit_output', input: { summary: 'too late' } }]),
  ]);
  const deps = makeDeps({ db, model, provider: 'anthropic', modelId: 'claude-opus-5-5' });
  const r = await runTask(task, deps);
  assert.equal(r.status, 'budget_exceeded');
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(db.tasks.get(task.id)!.status, 'failed');
  assert.match(String(db.callsOf('failTask')[0]?.args[1]), /Budget exceeded: \$4\.0\d+ > \$0\.90/);
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
    agent_id: 'seo-1', revision_count: 1, output: { summary: 'v1' },
    qa_feedback: { source: 'qa', fix_list: ['Shorten the title'], failed_checks: [{ criterion: 'Title ≤ 60 characters', note: '72 chars' }] },
  });
  const text = buildTaskPrompt(task, null, makeDeps({ db, model: mockModel([]) }));
  assert.match(text, /Shorten the title/);
  assert.match(text, /Title ≤ 60 characters: 72 chars/);
  assert.match(text, /"summary":"v1"/);
  assert.match(text, /brain\/sops\/seo-article\.md/);
});
