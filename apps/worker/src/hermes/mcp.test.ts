// HQ MCP tool server through the real worker HTTP server (ephemeral port) with FakeHqDb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../http';
import { FakeHqDb } from '../fakeHqDb';
import { loadRole } from '../roles';
import { makeDeps, mockModel } from '../testing';
import type { WorkerDeps } from '../deps';
import { createHqMcpRoutes } from './mcp';

const WRITER_TOKEN = 'writer-token-'.padEnd(48, 'w');
const SALES_TOKEN = 'sales-token-'.padEnd(48, 's');

async function withMcp(fn: (rpc: (body: unknown, token?: string | null) => Promise<{ status: number; body: any }>, ctx: { db: FakeHqDb; deps: WorkerDeps }) => Promise<void>, o: { tokens?: Map<string, string> } = {}) {
  const db = new FakeHqDb();
  const deps = makeDeps({ db, model: mockModel([]) });
  const routes = createHqMcpRoutes({ deps: () => deps, tokens: () => o.tokens ?? new Map([[WRITER_TOKEN, 'writer'], [SALES_TOKEN, 'sales']]) });
  const server = createHttpServer({ chat: async () => ({ answer: '' }), health: () => ({}) }, 'internal-secret-not-used-by-mcp', routes);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const rpc = async (body: unknown, token: string | null = WRITER_TOKEN) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  try { await fn(rpc, { db, deps }); } finally { server.close(); }
}

const call = (name: string, args: Record<string, unknown>, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('MCP auth: bearer token required and mapped to one agent; no tokens configured → 503', async () => {
  await withMcp(async (rpc) => {
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, null)).status, 401);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'x'.repeat(48))).status, 401);
    const ok = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.deepEqual(ok.body, { jsonrpc: '2.0', id: 1, result: {} });
  });
  await withMcp(async (rpc) => {
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 503);
  }, { tokens: new Map() });
});

test('MCP initialize + notifications + tools/list shows exactly the role\'s tools', async () => {
  await withMcp(async (rpc) => {
    const init = await rpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hermes', version: '1' } } });
    assert.equal(init.body.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.body.result.serverInfo.name, 'rizehub-hq');
    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(note.status, 202);

    const writer = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = writer.body.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(names, [...new Set(loadRole('writer').tools)].sort());
    const sub = writer.body.result.tools.find((t: { name: string }) => t.name === 'submit_output');
    assert.equal(sub.inputSchema.type, 'object');
    assert.ok(sub.inputSchema.properties.summary, 'zod schema converted to JSON Schema');
    assert.ok(sub.inputSchema.properties.task_id, 'every tool accepts an optional task_id');

    const sales = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, SALES_TOKEN);
    const salesNames = sales.body.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(salesNames, [...new Set(loadRole('sales').tools)].sort());
    assert.notDeepEqual(salesNames, names);

    const unknown = await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    assert.equal(unknown.body.error.code, -32601);
  });
});

test('MCP tools/call: request_external_action only creates a CEO approval (logged), acting on the agent\'s current task', async () => {
  await withMcp(async (rpc, { db }) => {
    const task = db.addTask({ agent_id: 'writer', status: 'working' });
    db.agents.get('writer')!.current_task_id = task.id;
    const r = await rpc(call('request_external_action', { type: 'publish_article', spec: 'Publish the article on madammuse.co/blogs/news' }));
    assert.equal(r.body.result.isError, false);
    assert.match(r.body.result.content[0].text, /Queued for CEO approval/);
    const ap = db.approvals.filter((a) => a.kind === 'external_action');
    assert.equal(ap.length, 1);
    assert.equal(ap[0]!.task_id, task.id);
    assert.equal((ap[0]!.payload as { action_type: string }).action_type, 'publish_article');
    assert.equal(db.tasks.get(task.id)!.status, 'working', 'nothing executed; the task keeps going');
    const logged = db.activity.filter((a) => a.action === 'mcp.tool_call');
    assert.equal(logged.length, 1);
    assert.deepEqual({ tool: logged[0]!.detail.tool, ok: logged[0]!.detail.ok, actor: logged[0]!.actor, task: logged[0]!.task_id },
      { tool: 'request_external_action', ok: true, actor: 'writer', task: task.id });
    assert.ok(!JSON.stringify(logged[0]!.detail).includes('madammuse'), 'arguments are not logged');

    // report_progress + submit_output through MCP (explicit task_id works too)
    await rpc(call('report_progress', { percent: 40, note: 'Drafting', task_id: task.id }));
    assert.equal(db.screens.get('writer')?.step_note, 'Drafting');
    const sub = await rpc(call('submit_output', { summary: 'Article done', content: '# Hello', criteria_map: [{ criterion: 'a', how_met: 'yes' }] }));
    assert.match(sub.body.result.content[0].text, /Submitted to QA/);
    assert.equal(db.tasks.get(task.id)!.status, 'qa_pending');
  });
});

test('MCP tools/call: no active task, someone else\'s task, bad arguments and unknown tools are refused', async () => {
  await withMcp(async (rpc, { db }) => {
    const none = await rpc(call('report_progress', { percent: 1, note: 'x' }));
    assert.equal(none.body.result.isError, true);
    assert.match(none.body.result.content[0].text, /No active HQ task/);

    const other = db.addTask({ agent_id: 'sales', status: 'working' });
    const foreign = await rpc(call('report_progress', { percent: 1, note: 'x', task_id: other.id }));
    assert.match(foreign.body.result.content[0].text, /not assigned to writer/);

    const mine = db.addTask({ agent_id: 'writer', status: 'working' });
    db.agents.get('writer')!.current_task_id = mine.id;
    const bad = await rpc(call('report_progress', { percent: 'lots' }));
    assert.equal(bad.body.result.isError, true);
    assert.match(bad.body.result.content[0].text, /Invalid arguments/);

    const unknown = await rpc(call('bash_sandboxed', { command: 'ls' }));
    assert.equal(unknown.body.error.code, -32602, 'a web-dev tool is not in the writer\'s role');
    assert.equal(db.approvals.length, 0);
  });
});
