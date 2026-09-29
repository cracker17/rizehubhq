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
import { MockLanguageModelV2 } from 'ai/test';
import type { WorkerDeps } from '../deps';
import { createHqMcpRoutes } from './mcp';
import { activeHermesLease } from './mcpState';
import { hermesPricing, parseFinalAnswer } from './runner';
import { costUsd } from '../models/usage';
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
/** Deps with a paid budget: the configured Hermes model (claude-sonnet-5) is paid, so it needs one to run. */
const paidDeps = (o: Parameters<typeof makeDeps>[0], monthlyBudgetUsd = 50) => Object.assign(makeDeps(o), { monthlyBudgetUsd });

test('budget: a paid Hermes model needs budget left (else built-in runner); a :free model runs with $0', async () => {
  const srv = await hermes(() => [200, completion('Done: the article.', { prompt_tokens: 100, completion_tokens: 50 })]);
  try {
    const a = setup();
    await runTask(a.task, paidDeps({ db: a.db, model: mockModel([]) }, 0), { hermes: { resolve: () => cfg(srv.url, { model: 'moonshotai/kimi-k2.6' }) } });
    const fb = a.db.activity.find((x) => x.action === 'hermes.fallback');
    assert.match(String((fb?.detail as { reason?: string } | undefined)?.reason), /no paid budget for the Hermes model \(MONTHLY_BUDGET_USD is 0/);
    assert.equal(srv.seen.filter((s) => s.path === '/v1/chat/completions').length, 0, 'Hermes was never asked');

    const b = setup();
    await runTask(b.task, paidDeps({ db: b.db, model: mockModel([]) }, 0), { hermes: { resolve: () => cfg(srv.url, { model: 'meta-llama/llama-4:free' }) } });
    assert.equal(b.db.activity.filter((x) => x.action === 'hermes.fallback').length, 0, 'a :free model needs no budget');
    assert.equal(srv.seen.filter((s) => s.path === '/v1/chat/completions').length, 1);

    const c = setup();
    const spent: number[] = [];
    const deps = Object.assign(paidDeps({ db: c.db, model: mockModel([]) }), { recordSpend: (usd: number) => { spent.push(usd); } });
    await runTask(c.task, deps, { hermes: { resolve: () => cfg(srv.url, { model: 'moonshotai/kimi-k2.6' }) } });
    assert.equal(spent.length, 1, 'Hermes spend reaches the live month/day totals');
    assert.ok(spent[0]! > 0);
  } finally { await srv.close(); }
});

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
  const deps = paidDeps({ db, model });
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
    assert.match(user!.content, /Pass task_id "[0-9a-f-]{36}" and run_id "[0-9a-f-]{36}" to every HQ tool call/);
    assert.match(user!.content, /NO publish, send, merge, deploy or payment credentials/);

    assert.equal(db.usage.length, 1);
    assert.equal(db.usage[0]!.detail.runtime, 'hermes');
    assert.equal(db.usage[0]!.detail.provider, 'anthropic');
    assert.ok(Math.abs(db.usage[0]!.costUsd - (10_000 * 2 + 2_000 * 10) / 1e6) < 1e-9, `priced as claude-sonnet: ${db.usage[0]!.costUsd}`);
    assert.equal(db.callsOf('finishAgentTurn').at(-1)?.args[0], 'writer');
    assert.equal(db.activity.filter((a) => a.action === 'hermes.fallback').length, 0);
  } finally { await srv.close(); }
});

/** The worker's HQ MCP endpoint on an ephemeral port + a caller that acts like Hermes (tool calls with arguments). */
async function mcpWorker(deps: () => WorkerDeps) {
  const TOKEN = 'mcp-writer-token'.padEnd(48, 'x');
  const worker = createHttpServer({ chat: async () => ({ answer: '' }), health: () => ({}) }, 'unused-secret',
    createHqMcpRoutes({ deps, tokens: () => new Map([[TOKEN, 'writer']]) }));
  await new Promise<void>((r) => worker.listen(0, '127.0.0.1', r));
  const mcpUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}/mcp`;
  const tool = (name: string, args: Record<string, unknown>): Promise<{ result: { isError: boolean; content: { text: string }[] } }> =>
    fetch(mcpUrl, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then((r) => r.json() as never);
  return { tool, close: () => { worker.closeAllConnections?.(); worker.close(); } };
}

/** The run id HQ put in the Hermes prompt (what a Hermes agent reads and passes along). */
function runIdOf(req: { body: unknown }): string {
  const user = (req.body as { messages: { content: string }[] }).messages[1]!.content;
  return /run_id "([0-9a-f-]{36})"/.exec(user)![1]!;
}

test('hermes agent: submit_output through the HQ MCP endpoint during the run wins over the final text', async () => {
  const { db, task } = setup();
  const deps = paidDeps({ db, model: mockModel([]) });
  const w = await mcpWorker(() => deps);
  let runId = '';
  const srv = await hermes(async (req) => {
    // What Hermes does server-side: call HQ tools over MCP (task_id + run_id from the prompt), then answer.
    runId = runIdOf(req);
    await w.tool('report_progress', { percent: 60, note: 'Writing in Hermes', task_id: task.id, run_id: runId });
    await w.tool('submit_output', { summary: 'Via MCP', content: 'body', criteria_map: CRITERIA.map((c) => ({ criterion: c, how_met: 'ok' })), run_id: runId });
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
    assert.ok(db.activity.filter((a) => a.action === 'mcp.tool_call').every((a) => a.detail.run_id === runId));
    // The run is over: its lease is gone and a straggling call is refused.
    assert.equal(activeHermesLease(task.id), null);
    const late = await w.tool('report_progress', { percent: 99, note: 'after the run', run_id: runId });
    assert.equal(late.result.isError, true);
    assert.ok(!db.callsOf('reportProgress').some((c) => c.args[2] === 'after the run'));
  } finally { await srv.close(); w.close(); }
});

test('hermes agent: {"ask_ceo": …} in the final answer pauses the task', async () => {
  const { db, task } = setup();
  const srv = await hermes(() => [200, completion('```json\n{"ask_ceo":{"question":"Which collection should it link to?","options":["Bundles","Sale"]}}\n```')]);
  try {
    const r = await runTask(task, paidDeps({ db, model: mockModel([]) }), { hermes: { resolve: () => cfg(srv.url) } });
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
  const deps = paidDeps({ db, model });
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
  const r3 = await runTask(task3, paidDeps({ db: db3, model: model3 }), { hermes: { resolve: () => cfg(url), healthTimeoutMs: 1_000 } });
  assert.equal(r3.status, 'submitted');
  assert.equal(model3.doGenerateCalls.length, 1);
  assert.match(String(fallbackRows(db3)[0]!.detail.note), /\(health check failed: down: Hermes unreachable/);
});

test('fallback: Hermes times out mid-run → built-in runner (task still working)', async () => {
  const { db, task } = setup();
  const model = builtinWorks();
  const srv = await hermes(() => 'hang');
  try {
    const r = await runTask(task, paidDeps({ db, model }), { hermes: { resolve: () => cfg(srv.url, { timeoutMs: 150 }) } });
    assert.equal(r.status, 'submitted');
    assert.equal((db.tasks.get(task.id)!.output as unknown as TaskOutput).summary, 'built-in output');
    assert.match(String(fallbackRows(db)[0]!.detail.reason), /^timeout: Hermes did not answer/);
  } finally { await srv.close(); }
});

test('HERMES_FALLBACK=off: down → task re-queued; not configured → task failed; 401 → task failed (no fallback)', async () => {
  {
    const { db, task } = setup();
    const r = await runTask(task, paidDeps({ db, model: mockModel([]) }), { hermes: { resolve: () => cfg('http://127.0.0.1:1'), fallback: false, healthTimeoutMs: 500 } });
    assert.equal(r.status, 'requeued');
    assert.equal(db.tasks.get(task.id)!.status, 'queued');
  }
  {
    const { db, task } = setup();
    const r = await runTask(task, paidDeps({ db, model: mockModel([]) }), { hermes: { resolve: () => null, fallback: false } });
    assert.equal(r.status, 'failed');
    assert.match(String(db.callsOf('failTask')[0]?.args[1]), /HERMES_FALLBACK=off/);
  }
  {
    const { db, task } = setup();
    const model = mockModel([]);
    const srv = await hermes(() => [401, { error: 'bad key' }]);
    try {
      const r = await runTask(task, paidDeps({ db, model }), { hermes: { resolve: () => cfg(srv.url) } });
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
  const r = await runTask(task, paidDeps({ db, model }), { hermes: { resolve: () => { resolved++; return null; } } });
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
  // vendor/model = OpenRouter (Hermes' default provider): priced, never silently $0 unless it is a :free model
  assert.deepEqual(hermesPricing('anthropic/claude-haiku-5', null), { provider: 'openrouter', modelId: 'anthropic/claude-haiku-5' });
  assert.deepEqual(hermesPricing('hermes-agent', 'moonshotai/kimi-k2.6'), { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.6' });
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const cost = (m: string) => { const p = hermesPricing('hermes-agent', m); return costUsd(p.provider, p.modelId, usage); };
  assert.equal(cost('moonshotai/kimi-k2.6'), 0.95 + 4, 'known model: its own price');
  assert.equal(cost('anthropic/claude-sonnet-5'), 2 + 10);
  assert.ok(cost('some-lab/unknown-model') > 0, 'unknown paid model: fallback price, not free');
  assert.equal(cost('meta-llama/llama-4:free'), 0);
  assert.deepEqual(hermesPricing('hermes-agent', 'claude-sonnet-5'), { provider: 'anthropic', modelId: 'claude-sonnet-5' });
  assert.equal(hermesPricing('hermes-agent', null).provider, 'hermes');
});

// ---------- run lease: a Hermes container that keeps working after a fallback ----------

test('run lease: after a timeout fallback, late Hermes tool calls are refused and change nothing; the built-in run is unaffected', async () => {
  const { db, task } = setup();
  let runId = '';
  const late: { tool: string; isError: boolean; text: string }[] = [];
  const order: string[] = [];
  let w!: Awaited<ReturnType<typeof mcpWorker>>;
  // The built-in runner's model: while it works, the Hermes container (whose request to us timed out) keeps
  // calling HQ tools on the same task with its old run id.
  const model: MockLanguageModelV2 = new MockLanguageModelV2({
    doGenerate: async () => {
      order.push('builtin:step');
      for (const [name, args] of [
        ['report_progress', { percent: 90, note: 'late Hermes progress' }],
        ['request_external_action', { type: 'publish_article', spec: 'Publish it now' }],
        ['submit_output', { summary: 'late Hermes output', content: 'y' }],
        ['ask_ceo', { question: 'late question?' }],
      ] as const) {
        const r = await w.tool(name, { ...args, task_id: task.id, run_id: runId });
        late.push({ tool: name, isError: r.result.isError, text: r.result.content[0]!.text });
      }
      return toolCalls([{ name: 'submit_output', input: { summary: 'built-in output', content: 'x' } }]);
    },
  });
  const deps = paidDeps({ db, model });
  w = await mcpWorker(() => deps);
  const srv = await hermes((req) => { runId = runIdOf(req); return 'hang'; });
  try {
    const r = await runTask(task, deps, { hermes: { resolve: () => cfg(srv.url, { timeoutMs: 150 }) } });
    assert.equal(r.status, 'submitted');
    assert.deepEqual(order, ['builtin:step']);
    assert.match(String(fallbackRows(db)[0]!.detail.reason), /^timeout:/);

    // Every late call was refused with a clear reason…
    assert.equal(late.length, 4);
    for (const l of late) {
      assert.equal(l.isError, true, `${l.tool} refused`);
      assert.match(l.text, /HQ ended this Hermes run .*timeout; HQ took the task back.*Stop working on this task/);
    }
    // …and changed nothing: the built-in runner's output stands; no approval, progress or CEO question from Hermes.
    const t = db.tasks.get(task.id)!;
    assert.equal(t.status, 'qa_pending');
    assert.equal((t.output as unknown as TaskOutput).summary, 'built-in output');
    assert.equal(db.callsOf('submitTaskOutput').length, 1);
    assert.equal(db.callsOf('askCeo').length, 0);
    assert.equal(db.approvals.length, 0);
    assert.ok(!db.callsOf('reportProgress').some((c) => c.args[2] === 'late Hermes progress'));
    assert.equal(db.activity.filter((a) => a.action === 'mcp.tool_call').length, 0);
    assert.equal(db.activity.filter((a) => a.action === 'mcp.tool_refused').length, 4);

    // Still refused after the task moved on (now with QA).
    const after = await w.tool('submit_output', { summary: 'even later', run_id: runId });
    assert.equal(after.result.isError, true);
    assert.equal((db.tasks.get(task.id)!.output as unknown as TaskOutput).summary, 'built-in output');
  } finally { await srv.close(); w.close(); }
});

test('run lease: a Hermes tool call already executing at the timeout finishes before the built-in runner starts', async () => {
  const { db, task } = setup();
  const order: string[] = [];
  const model: MockLanguageModelV2 = new MockLanguageModelV2({
    doGenerate: async () => { order.push('builtin:step'); return toolCalls([{ name: 'submit_output', input: { summary: 'built-in output', content: 'x' } }]); },
  });
  const deps = paidDeps({ db, model });
  const orig = db.reportProgress.bind(db);
  db.reportProgress = async (...a: Parameters<typeof orig>) => {
    if (a[2] === 'slow Hermes step') { order.push('hermes:start'); await new Promise((r) => setTimeout(r, 400)); order.push('hermes:end'); }
    return orig(...a);
  };
  const w = await mcpWorker(() => deps);
  const srv = await hermes((req) => {
    void w.tool('report_progress', { percent: 50, note: 'slow Hermes step', run_id: runIdOf(req) });
    return 'hang';
  });
  try {
    const r = await runTask(task, deps, { hermes: { resolve: () => cfg(srv.url, { timeoutMs: 150 }) } });
    assert.equal(r.status, 'submitted');
    assert.deepEqual(order, ['hermes:start', 'hermes:end', 'builtin:step'], 'the fallback waited for the in-flight call');
  } finally { await srv.close(); w.close(); }
});

test('run lease: a Hermes tool call still running past the drain window → task re-queued, built-in runner not started', async () => {
  const { db, task } = setup();
  const model = mockModel([]);
  const deps = paidDeps({ db, model });
  const orig = db.reportProgress.bind(db);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  db.reportProgress = async (...a: Parameters<typeof orig>) => {
    if (a[2] === 'stuck Hermes step') await gate;
    return orig(...a);
  };
  const w = await mcpWorker(() => deps);
  const srv = await hermes((req) => {
    void w.tool('report_progress', { percent: 50, note: 'stuck Hermes step', run_id: runIdOf(req) });
    return 'hang';
  });
  try {
    const r = await runTask(task, deps, { hermes: { resolve: () => cfg(srv.url, { timeoutMs: 150 }), drainMs: 100 } });
    assert.equal(r.status, 'requeued');
    assert.match(r.status === 'requeued' ? r.reason : '', /still running, re-queued instead of falling back/);
    assert.equal(model.doGenerateCalls.length, 0, 'no double work');
    assert.equal(db.tasks.get(task.id)!.status, 'queued');
    assert.equal(fallbackRows(db).length, 0);
    assert.equal(db.callsOf('finishAgentTurn').at(-1)?.args[0], 'writer');
  } finally { release(); await srv.close(); w.close(); }
});
