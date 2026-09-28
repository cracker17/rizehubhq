// Hermes runtime: routing, output saving, MCP round trip and the fallback to the built-in runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { runTask } from '../runner';
import { FakeHqDb } from '../fakeHqDb';
import { createHttpServer } from '../http';
import { makeDeps, mockModel, promptText, toolCalls } from '../testing';
import type { TaskOutput } from '../hqdb';
import type { HermesAgentConfig } from './config';
import { createHqMcpRoutes } from './mcp';
import { hermesPricing, parseFinalAnswer } from './runner';
import { completion, deadUrl, startMockHermes, type MockHandler } from './testServer';

const KEY = 'hermes-writer-api-key';
const CRITERIA = ['H1 contains "shopify speed"', 'Title ≤ 60 characters', 'At least 3 internal links'];

function setup() {
  const db = new FakeHqDb();
  const task = db.addTask({ agent_id: 'writer', title: 'Shopify speed article', acceptance_criteria: CRITERIA, status: 'working' });
  db.agents.get('writer')!.current_task_id = task.id;
  return { db, task: { ...task } };
}
const cfg = (url: string, extra: Partial<HermesAgentConfig> = {}): HermesAgentConfig =>
  ({ agentId: 'writer', url, key: KEY, timeoutMs: 5_000, model: 'claude-sonnet-5', ...extra });

async function hermes(handler: MockHandler) {
  return startMockHermes((r) => (r.path === '/health' ? [200, { status: 'ok' }] : handler(r)));
}

test('hermes agent: task goes to its Hermes instance; the final answer is saved as the task output', async () => {
  const { db, task } = setup();
  const answer = 'Done.\n```json\n' + JSON.stringify({
    summary: '1,200-word article on Shopify speed', content: '# Shopify speed\n...', links: ['https://example.com'],
    criteria_map: CRITERIA.map((c) => ({ criterion: c, how_met: 'yes' })),
  }) + '\n```';
  const srv = await hermes(() => [200, completion(answer, { prompt_tokens: 10_000, completion_tokens: 2_000 })]);
  const model = mockModel([]);
  const deps = makeDeps({ db, model });
  try {
    const r = await runTask(task, deps, { hermes: { resolve: () => cfg(srv.url) }, heartbeatMs: 5 });
    assert.deepEqual(r.status === 'submitted' && r.fallback, false);
    assert.equal(model.doGenerateCalls.length, 0, 'the built-in runner was not used');
    const out = db.tasks.get(task.id)!.output as unknown as TaskOutput;
    assert.equal(out.summary, '1,200-word article on Shopify speed');
    assert.equal(out.criteria_map[CRITERIA[2]!], 'yes');
    assert.deepEqual(out.links, ['https://example.com']);
    assert.equal(db.tasks.get(task.id)!.status, 'qa_pending');

    const chat = srv.seen.find((s) => s.path === '/v1/chat/completions')!;
    assert.equal(chat.headers.authorization, `Bearer ${KEY}`);
    assert.equal(chat.headers['x-hermes-session-id'], task.id);
    assert.equal(chat.headers['x-hermes-session-key'], 'writer');
    const [sys, user] = (chat.body as { messages: { role: string; content: string }[] }).messages;
    assert.equal(sys!.role, 'system');
    assert.match(sys!.content, /You are RizeHub's Content Writer/);
    assert.match(user!.content, /At least 3 internal links/);
    assert.match(user!.content, /brain\/sops\/seo-article\.md/);
    assert.match(user!.content, /Pass task_id "[0-9a-f-]{36}" to every HQ tool call/);
    assert.match(user!.content, /NO publish, send, merge, deploy or payment credentials/);

    assert.equal(db.usage.length, 1);
    assert.equal(db.usage[0]!.detail.runtime, 'hermes');
    assert.equal(db.usage[0]!.detail.provider, 'anthropic');
    assert.ok(Math.abs(db.usage[0]!.costUsd - (10_000 * 2 + 2_000 * 10) / 1e6) < 1e-9, `priced as claude-sonnet: ${db.usage[0]!.costUsd}`);
    assert.equal(db.callsOf('finishAgentTurn').at(-1)?.args[0], 'writer');
    assert.equal(db.activity.filter((a) => a.action === 'hermes.fallback').length, 0);
  } finally { await srv.close(); }
});

test('hermes agent: submit_output through the HQ MCP endpoint during the run wins over the final text', async () => {
  const { db, task } = setup();
  const deps = makeDeps({ db, model: mockModel([]) });
  const TOKEN = 'mcp-writer-token'.padEnd(48, 'x');
  const worker = createHttpServer({ chat: async () => ({ answer: '' }), health: () => ({}) }, 'unused-secret',
    createHqMcpRoutes({ deps: () => deps, tokens: () => new Map([[TOKEN, 'writer']]) }));
  await new Promise<void>((r) => worker.listen(0, '127.0.0.1', r));
  const mcpUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}/mcp`;
  const srv = await hermes(async () => {
    // What Hermes does server-side: call HQ tools over MCP, then answer.
    const mcp = (method: string, params: unknown) => fetch(mcpUrl, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
    await mcp('tools/call', { name: 'report_progress', arguments: { percent: 60, note: 'Writing in Hermes' } });
    await mcp('tools/call', { name: 'submit_output', arguments: { summary: 'Via MCP', content: 'body', criteria_map: CRITERIA.map((c) => ({ criterion: c, how_met: 'ok' })) } });
    return [200, completion('I submitted the article.')];
  });
  try {
    const r = await runTask(task, deps, { hermes: { resolve: () => cfg(srv.url) } });
    assert.equal(r.status, 'submitted');
    const out = db.tasks.get(task.id)!.output as unknown as TaskOutput;
    assert.equal(out.summary, 'Via MCP');
    assert.equal(db.callsOf('submitTaskOutput').length, 1, 'the final text was not submitted a second time');
    assert.ok(db.callsOf('reportProgress').some((c) => c.args[2] === 'Writing in Hermes'));
    assert.deepEqual(db.activity.filter((a) => a.action === 'mcp.tool_call').map((a) => a.detail.tool), ['report_progress', 'submit_output']);
  } finally { await srv.close(); worker.close(); }
});

test('hermes agent: {"ask_ceo": …} in the final answer pauses the task', async () => {
  const { db, task } = setup();
  const srv = await hermes(() => [200, completion('```json\n{"ask_ceo":{"question":"Which collection should it link to?","options":["Bundles","Sale"]}}\n```')]);
  try {
    const r = await runTask(task, makeDeps({ db, model: mockModel([]) }), { hermes: { resolve: () => cfg(srv.url) } });
    assert.equal(r.status, 'asked_ceo');
    assert.equal(db.tasks.get(task.id)!.status, 'awaiting_ceo');
    assert.deepEqual(db.callsOf('askCeo')[0]?.args.slice(1), ['Which collection should it link to?', ['Bundles', 'Sale']]);
  } finally { await srv.close(); }
});

function builtinWorks() {
  return mockModel([toolCalls([{ name: 'submit_output', input: { summary: 'built-in output', content: 'x' } }])]);
}
const fallbackRows = (db: FakeHqDb) => db.activity.filter((a) => a.action === 'hermes.fallback');

test('fallback: Hermes not configured → built-in runner + activity note', async () => {
  const { db, task } = setup();
  const model = builtinWorks();
  const deps = makeDeps({ db, model });
  const r = await runTask(task, deps, { hermes: { resolve: () => null } });
  assert.equal(r.status, 'submitted');
  assert.equal(model.doGenerateCalls.length, 1);
  assert.match(promptText(model.doGenerateCalls[0]!), /At least 3 internal links/);
  const rows = fallbackRows(db);
  assert.equal(rows.length, 1);
  assert.match(String(rows[0]!.detail.note), /^Hermes unavailable for writer, ran on the built-in runner \(not configured: set HERMES_URL_WRITER/);
  assert.equal(rows[0]!.task_id, task.id);
  assert.ok(deps.logs.some((l) => /Hermes unavailable for writer/.test(l)));
});

test('fallback: /health down → built-in runner', async () => {
  const { db: db3, task: task3 } = setup();
  const model3 = builtinWorks();
  const url = await deadUrl();
  const r3 = await runTask(task3, makeDeps({ db: db3, model: model3 }), { hermes: { resolve: () => cfg(url), healthTimeoutMs: 1_000 } });
  assert.equal(r3.status, 'submitted');
  assert.equal(model3.doGenerateCalls.length, 1);
  assert.match(String(fallbackRows(db3)[0]!.detail.note), /\(health check failed: down: Hermes unreachable/);
});

test('fallback: Hermes times out mid-run → built-in runner (task still working)', async () => {
  const { db, task } = setup();
  const model = builtinWorks();
  const srv = await hermes(() => 'hang');
  try {
    const r = await runTask(task, makeDeps({ db, model }), { hermes: { resolve: () => cfg(srv.url, { timeoutMs: 150 }) } });
    assert.equal(r.status, 'submitted');
    assert.equal((db.tasks.get(task.id)!.output as unknown as TaskOutput).summary, 'built-in output');
    assert.match(String(fallbackRows(db)[0]!.detail.reason), /^timeout: Hermes did not answer/);
  } finally { await srv.close(); }
});

test('HERMES_FALLBACK=off: down → task re-queued; not configured → task failed; 401 → task failed (no fallback)', async () => {
  {
    const { db, task } = setup();
    const r = await runTask(task, makeDeps({ db, model: mockModel([]) }), { hermes: { resolve: () => cfg('http://127.0.0.1:1'), fallback: false, healthTimeoutMs: 500 } });
    assert.equal(r.status, 'requeued');
    assert.equal(db.tasks.get(task.id)!.status, 'queued');
  }
  {
    const { db, task } = setup();
    const r = await runTask(task, makeDeps({ db, model: mockModel([]) }), { hermes: { resolve: () => null, fallback: false } });
    assert.equal(r.status, 'failed');
    assert.match(String(db.callsOf('failTask')[0]?.args[1]), /HERMES_FALLBACK=off/);
  }
  {
    const { db, task } = setup();
    const model = mockModel([]);
    const srv = await hermes(() => [401, { error: 'bad key' }]);
    try {
      const r = await runTask(task, makeDeps({ db, model }), { hermes: { resolve: () => cfg(srv.url) } });
      assert.deepEqual(r.status === 'failed' && r.reason, 'Hermes run failed (unauthorized): Hermes rejected the API key (HTTP 401)');
      assert.equal(model.doGenerateCalls.length, 0);
      assert.equal(db.tasks.get(task.id)!.status, 'failed');
    } finally { await srv.close(); }
  }
});

test('worker-runtime agents never touch Hermes', async () => {
  const db = new FakeHqDb();
  const task = db.addTask({ agent_id: 'coo', work_type: 'daily-report', status: 'working' });
  const model = builtinWorks();
  let resolved = 0;
  const r = await runTask(task, makeDeps({ db, model }), { hermes: { resolve: () => { resolved++; return null; } } });
  assert.equal(r.status, 'submitted');
  assert.equal(resolved, 0);
  assert.equal(fallbackRows(db).length, 0);
});

test('parseFinalAnswer / hermesPricing', () => {
  const plain = parseFinalAnswer('Just the article text');
  assert.equal(plain.kind === 'output' && plain.output.fallback, true);
  const rec = parseFinalAnswer('{"summary":"s","criteria_map":{"a":"b"}}');
  assert.deepEqual(rec.kind === 'output' && rec.output.criteria_map, { a: 'b' });
  assert.equal(parseFinalAnswer('  ').kind, 'empty');
  assert.deepEqual(hermesPricing('anthropic/claude-haiku-5', null), { provider: 'anthropic', modelId: 'claude-haiku-5' });
  assert.deepEqual(hermesPricing('hermes-agent', 'claude-sonnet-5'), { provider: 'anthropic', modelId: 'claude-sonnet-5' });
  assert.equal(hermesPricing('hermes-agent', null).provider, 'hermes');
});
