// Claude runtime: routing, SDK options (prompt, system prompt, cwd, tools, permissions, MCP token, budget), output and
// usage, the HQ MCP round trip with the per-run token, and every fallback to the built-in runner. The SDK is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runTask, type RunOptions } from '../runner';
import { FakeHqDb } from '../fakeHqDb';
import { createHttpServer } from '../http';
import { makeDeps, mockModel, promptText, toolCalls } from '../testing';
import type { TaskOutput } from '../hqdb';
import { loadRole } from '../roles';
import { createHqMcpRoutes, agentToolNames } from '../hermes/mcp';
import { activeHermesLease } from '../hermes/mcpState';
import { ALWAYS_DISALLOWED, claudeBudget, claudeProcessEnv, hqToolId, priceRun, redact, type QueryFn } from './runner';
import { NATIVE_FILE_TOOLS } from './guard';

const KEY = 'sk-ant-api03-test-key-'.padEnd(60, 'k');
const CRITERIA = ['Section renders on mobile', 'Uses theme settings', 'No console errors'];
const ROLE = { ...loadRole('web-dev'), runtime: 'claude' as const };
const baseEnv = {
  CLAUDE_RUNTIME_ENABLED: 'true', ANTHROPIC_API_KEY: KEY, CLAUDE_MODEL: 'claude-sonnet-5', PATH: process.env.PATH,
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_never_passed_on', VAULT_MASTER_KEY: 'vault-never-passed-on',
};

function setup(o: { spend?: { monthlyBudgetUsd: number; spentThisMonthUsd: number; dailyBudgetUsd: number | null; spentTodayUsd: number }; builtin?: ReturnType<typeof mockModel> } = {}) {
  const db = new FakeHqDb();
  const task = db.addTask({ agent_id: 'web-dev', title: 'Hero section', acceptance_criteria: CRITERIA, status: 'working' });
  db.agents.get('web-dev')!.current_task_id = task.id;
  const model = o.builtin ?? mockModel([toolCalls([{ name: 'submit_output', input: { summary: 'built-in output', content: 'x' } }])]);
  const spent: number[] = [];
  const deps = {
    ...makeDeps({ db, model }),
    loadRole: (id: string) => (id === 'web-dev' ? ROLE : loadRole(id)),
    spend: () => o.spend ?? { monthlyBudgetUsd: 50, spentThisMonthUsd: 10, dailyBudgetUsd: 5, spentTodayUsd: 4.2 },
    recordSpend: (usd: number) => { spent.push(usd); },
  };
  const workspacesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-claude-ws-'));
  return { db, task: { ...task }, deps, model, spent, workspacesDir };
}

type Script = (p: { prompt: string; options: Options }) => AsyncGenerator<SDKMessage>;
function fakeQuery(script: Script) {
  const seen: { prompt: string; options: Options }[] = [];
  let closed = 0;
  const query: QueryFn = (p) => { seen.push(p); return Object.assign(script(p), { close: () => { closed++; } }); };
  return { query, seen, closed: () => closed };
}

const modelUsage = { 'claude-sonnet-5': { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 10_000, cacheCreationInputTokens: 2000, webSearchRequests: 0, costUSD: 0.05, contextWindow: 1_000_000, maxOutputTokens: 64_000 } };
function result(subtype: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result', subtype, is_error: subtype !== 'success', num_turns: 4, duration_ms: 1, duration_api_ms: 1, stop_reason: 'end_turn',
    total_cost_usd: 0.05, usage: {}, modelUsage, permission_denials: [], errors: [], uuid: 'u', session_id: 's', ...extra,
  } as unknown as SDKMessage;
}
const success = (text: string, extra: Record<string, unknown> = {}) => result('success', { result: text, is_error: false, ...extra });
const finalJson = 'Done.\n```json\n' + JSON.stringify({
  summary: 'Hero section built', content: '{% schema %}…', files: ['sections/hero.liquid'],
  criteria_map: CRITERIA.map((c) => ({ criterion: c, how_met: 'checked' })),
}) + '\n```';

const opts = (workspacesDir: string, query: QueryFn, extra: Partial<NonNullable<RunOptions['claude']>> = {}, env: Record<string, string | undefined> = {}): RunOptions => ({
  heartbeatMs: 5, limits: { maxSteps: 25, maxCostUsd: 1.5 },
  claude: { query, env: { ...baseEnv, ...env }, workspacesDir, mcpUrl: 'http://127.0.0.1:9/mcp', drainMs: 50, ...extra },
});
const fallbackRows = (db: FakeHqDb) => db.activity.filter((a) => a.action === 'claude.fallback');

test('runtime claude: the SDK gets the role prompt, the task workspace, HQ tools only, dontAsk, the per-run MCP token and the budget cap', async () => {
  const s = setup();
  const f = fakeQuery(async function* () { yield success(finalJson); });
  const r = await runTask(s.task, s.deps, opts(s.workspacesDir, f.query));
  assert.deepEqual(r, { status: 'submitted', costUsd: 0.014, fallback: false });
  assert.equal(s.model.doGenerateCalls.length, 0, 'the built-in runner was not used');
  assert.equal(f.seen.length, 1);
  const { prompt, options: o } = f.seen[0]!;

  assert.equal(o.systemPrompt, ROLE.body, 'system prompt = role file body');
  assert.match(prompt, /# Task: Hero section/);
  assert.match(prompt, /No console errors/);
  assert.match(prompt, /## Running on Claude/);
  assert.match(prompt, /mcp__hq__bash_sandboxed/);
  assert.equal(o.cwd, fs.realpathSync(path.join(s.workspacesDir, s.task.id)), 'cwd = the task workspace');
  assert.ok(!o.cwd!.startsWith(path.resolve(import.meta.dirname, '../../../..', 'apps')), 'never the repo');

  assert.equal(o.permissionMode, 'dontAsk');
  assert.notEqual(o.permissionMode, 'bypassPermissions');
  assert.equal(o.allowDangerouslySkipPermissions, undefined);
  assert.equal(o.permissionPrompts, 'none');
  assert.deepEqual(o.tools, [], 'CLAUDE_FILE_TOOLS=hq (default): no Claude Code built-in tools');
  const names = await agentToolNames(s.deps, 'web-dev');
  assert.deepEqual([...o.allowedTools!].sort(), names.map(hqToolId).sort(), 'allowedTools = exactly the agent\'s HQ tools');
  for (const t of ['submit_output', 'ask_ceo', 'request_external_action', 'workspace_fs', 'bash_sandboxed']) assert.ok(o.allowedTools!.includes(hqToolId(t)), t);
  for (const t of [...ALWAYS_DISALLOWED, ...NATIVE_FILE_TOOLS]) assert.ok(o.disallowedTools!.includes(t), `${t} disallowed`);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  assert.equal(o.persistSession, false);

  const hq = o.mcpServers!.hq as { type: string; url: string; headers: Record<string, string>; alwaysLoad?: boolean };
  assert.equal(hq.type, 'http');
  assert.equal(hq.url, 'http://127.0.0.1:9/mcp');
  assert.match(hq.headers.Authorization!, /^Bearer [0-9a-f]{64}$/);
  assert.equal(hq.alwaysLoad, true);

  assert.equal(o.model, 'claude-sonnet-5');
  assert.equal(o.maxTurns, Math.min(ROLE.max_turns, 25));
  assert.equal(o.maxBudgetUsd, 0.8, 'min(role $1.50, task cap $1.50, month left $40, day left $0.80)');

  assert.equal(o.env!.ANTHROPIC_API_KEY, KEY);
  assert.equal(o.env!.SUPABASE_SERVICE_ROLE_KEY, undefined, 'no other worker secret reaches Claude Code');
  assert.equal(o.env!.VAULT_MASTER_KEY, undefined);
  assert.equal(o.env!.HOME, o.env!.CLAUDE_CONFIG_DIR);
  assert.ok(!fs.existsSync(o.env!.HOME!), 'the throwaway Claude home is removed after the run');

  const out = s.db.tasks.get(s.task.id)!.output as unknown as TaskOutput;
  assert.equal(out.summary, 'Hero section built');
  assert.equal(out.criteria_map[CRITERIA[1]!], 'checked');
  assert.equal(s.db.tasks.get(s.task.id)!.status, 'qa_pending');
  assert.equal(f.closed(), 1, 'the Claude Code process is closed');
  assert.equal(activeHermesLease(s.task.id), null, 'the run lease is revoked');

  // Usage: priced with HQ's table (sonnet $2/$10, cache read $0.20, write $2.50) = $0.014; counted toward the budgets.
  assert.equal(s.db.usage.length, 1);
  const u = s.db.usage[0]!;
  assert.deepEqual([u.actor, u.kind, u.taskId, u.tokensIn, u.tokensOut, u.costUsd], ['web-dev', 'task', s.task.id, 13_000, 500, 0.014]);
  assert.equal(u.detail.runtime, 'claude');
  assert.equal(u.detail.provider, 'anthropic');
  assert.equal(u.detail.model, 'claude-sonnet-5');
  assert.equal(u.detail.sdk_cost_usd, 0.05);
  assert.equal(u.detail.cached_in, 10_000);
  assert.deepEqual(s.spent, [0.014]);
  assert.equal(fallbackRows(s.db).length, 0);
  assert.equal(s.db.callsOf('finishAgentTurn').length, 1);
});

test('runtime claude: HQ tools over MCP with the per-run token (submit_output), refused after the run', async () => {
  const s = setup();
  const routes = createHqMcpRoutes({ deps: () => s.deps, tokens: () => new Map() });
  const server = createHttpServer({ chat: async () => ({ answer: '' }), health: () => ({}) }, 'internal-secret', routes);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  let hdr: Record<string, string> = {};
  const rpc = async (body: unknown) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...hdr }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  try {
    const f = fakeQuery(async function* (p) {
      hdr = (p.options.mcpServers!.hq as { headers: Record<string, string> }).headers;
      const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const sub = list.body.result.tools.find((t: { name: string }) => t.name === 'submit_output');
      assert.equal(sub.inputSchema.properties.run_id, undefined, 'a per-run token needs no run_id');
      assert.equal(sub.inputSchema.properties.task_id, undefined);
      const other = s.db.addTask({ agent_id: 'web-dev', status: 'working' });
      await rpc(call('report_progress', { percent: 50, note: 'Building', task_id: other.id }));
      const done = await rpc(call('submit_output', { summary: 'Via MCP', content: 'x', criteria_map: [{ criterion: 'a', how_met: 'b' }] }));
      assert.match(done.body.result.content[0].text, /Submitted to QA/);
      yield success('I submitted it.');
    });
    const r = await runTask(s.task, s.deps, opts(s.workspacesDir, f.query, { mcpUrl: url }));
    assert.equal(r.status, 'submitted');
    assert.equal((s.db.tasks.get(s.task.id)!.output as unknown as TaskOutput).summary, 'Via MCP', 'the MCP submit stands; the final text is ignored');
    assert.equal(s.db.callsOf('submitTaskOutput').length, 1);
    assert.equal(s.db.screens.get('web-dev')?.step_note, 'Building', 'the token pins the task: a task_id argument is ignored');
    const calls = s.db.activity.filter((a) => a.action === 'mcp.tool_call');
    assert.ok(calls.length >= 2 && calls.every((a) => a.detail.via === 'claude' && a.task_id === s.task.id));

    // The run is over: the same token is refused and changes nothing.
    s.db.tasks.get(s.task.id)!.status = 'working';
    const late = await rpc(call('submit_output', { summary: 'late' }));
    assert.equal(late.body.result.isError, true);
    assert.match(late.body.result.content[0].text, /HQ ended this Claude run/);
    assert.equal(s.db.callsOf('submitTaskOutput').length, 1);
  } finally { server.close(); }
});

test('runtime claude: CLAUDE_FILE_TOOLS=native gives Read/Edit/Write/Glob/Grep, jailed by the PreToolUse hook', async () => {
  const s = setup();
  let decisions: Record<string, unknown> = {};
  const f = fakeQuery(async function* (p) {
    const o = p.options;
    assert.deepEqual(o.tools, [...NATIVE_FILE_TOOLS]);
    for (const t of NATIVE_FILE_TOOLS) assert.ok(o.allowedTools!.includes(t));
    assert.ok(o.disallowedTools!.includes('Bash'));
    assert.ok(!o.disallowedTools!.includes('Read'));
    const hook = o.hooks!.PreToolUse![0]!.hooks[0]! as HookCallback;
    const ask = async (tool_name: string, tool_input: unknown) => {
      const out = await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: o.cwd! } as never, 't', { signal: new AbortController().signal });
      return (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision ?? 'ok';
    };
    fs.writeFileSync(path.join(o.cwd!, 'index.html'), '<h1>hi</h1>');
    decisions = {
      readInside: await ask('Read', { file_path: path.join(o.cwd!, 'index.html') }),
      writeRelative: await ask('Write', { file_path: 'sections/hero.liquid', content: 'x' }),
      readOutside: await ask('Read', { file_path: path.resolve(o.cwd!, '..', '..', 'secrets.txt') }),
      dotdot: await ask('Edit', { file_path: '../other-task/a.txt', old_string: 'a', new_string: 'b' }),
      envFile: await ask('Read', { file_path: path.join(o.cwd!, '.env') }),
      bash: await ask('Bash', { command: 'cat /proc/1/environ' }),
      webFetch: await ask('WebFetch', { url: 'https://example.com' }),
      hqTool: await ask(hqToolId('submit_output'), { summary: 'x' }),
      foreignMcp: await ask('mcp__other__exfiltrate', {}),
    };
    yield success(finalJson);
  });
  const r = await runTask(s.task, s.deps, opts(s.workspacesDir, f.query, {}, { CLAUDE_FILE_TOOLS: 'native' }));
  assert.equal(r.status, 'submitted');
  assert.match(f.seen[0]!.prompt, /Read, Edit, Write, Glob and Grep work only inside it/);
  assert.deepEqual(decisions, {
    readInside: 'ok', writeRelative: 'ok', readOutside: 'deny', dotdot: 'deny', envFile: 'deny', bash: 'deny', webFetch: 'deny', hqTool: 'ok', foreignMcp: 'deny',
  });
});

test('fallback: runtime off, no API key, no monthly budget, daily budget used → built-in runner + claude.fallback', async () => {
  const cases: [string, Record<string, string | undefined>, Parameters<typeof setup>[0], RegExp][] = [
    ['off', { CLAUDE_RUNTIME_ENABLED: undefined }, {}, /CLAUDE_RUNTIME_ENABLED is off/],
    ['no key', { ANTHROPIC_API_KEY: '' }, {}, /ANTHROPIC_API_KEY not set/],
    ['no budget', {}, { spend: { monthlyBudgetUsd: 0, spentThisMonthUsd: 0, dailyBudgetUsd: null, spentTodayUsd: 0 } }, /MONTHLY_BUDGET_USD is 0/],
    ['month used', {}, { spend: { monthlyBudgetUsd: 20, spentThisMonthUsd: 20, dailyBudgetUsd: null, spentTodayUsd: 0 } }, /monthly budget used up/],
    ['day used', {}, { spend: { monthlyBudgetUsd: 50, spentThisMonthUsd: 1, dailyBudgetUsd: 2, spentTodayUsd: 2 } }, /daily AI budget reached/],
  ];
  for (const [name, env, o, reason] of cases) {
    const s = setup(o);
    const f = fakeQuery(async function* () { yield success(finalJson); });
    const r = await runTask(s.task, s.deps, opts(s.workspacesDir, f.query, {}, env));
    assert.equal(r.status, 'submitted', name);
    assert.equal(f.seen.length, 0, `${name}: the SDK was not started`);
    assert.equal(s.model.doGenerateCalls.length, 1, `${name}: built-in runner ran`);
    assert.match(promptText(s.model.doGenerateCalls[0]!), /No console errors/);
    const rows = fallbackRows(s.db);
    assert.equal(rows.length, 1, name);
    assert.match(String(rows[0]!.detail.note), /^Claude unavailable for web-dev, ran on the built-in runner \(/);
    assert.match(String(rows[0]!.detail.reason), reason, name);
    assert.equal(s.db.usage.filter((u) => u.detail.runtime === 'claude').length, 0);
  }
});

test('fallback: SDK error / API error / timeout → lease revoked, built-in runner; no secret in logs or activity', async () => {
  let token = '';
  const grabToken = (p: { options: Options }) => { token = (p.options.mcpServers!.hq as { headers: Record<string, string> }).headers.Authorization!.slice(7); };
  const scripts: [string, Script, RegExp, Record<string, unknown>?][] = [
    ['sdk throws', async function* (p) {
      grabToken(p);
      p.options.stderr?.(`auth header x-api-key: ${KEY}\n`);
      throw new Error(`process exited: key ${KEY} token ${token}`);
    }, /^SDK error: process exited: key \[redacted\] token \[redacted\]/],
    ['api error', async function* (p) { grabToken(p); yield success('Invalid API key', { is_error: true, api_error_status: 401 }); }, /^API error 401: Invalid API key/],
    ['key rejected (Claude Code would retry for minutes)', async function* (p) {
      grabToken(p);
      yield { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 401, error: 'authentication_failed', uuid: 'u', session_id: 's' } as unknown as SDKMessage;
      await new Promise(() => undefined); // never resolves: the runner must stop reading by itself
    }, /^Anthropic API rejected ANTHROPIC_API_KEY \(HTTP 401\)/],
    ['execution error', async function* (p) { grabToken(p); yield result('error_during_execution', { errors: ['MCP server hq failed'] }); }, /^run failed: MCP server hq failed/],
    ['timeout', async function* (p) {
      grabToken(p);
      await new Promise((_, rej) => p.options.abortController!.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    }, /^timeout after 0s/, { timeoutMs: 80 }],
  ];
  for (const [name, script, reason, extra] of scripts) {
    const s = setup();
    const f = fakeQuery(script);
    const r = await runTask(s.task, s.deps, opts(s.workspacesDir, f.query, extra ?? {}));
    assert.equal(r.status, 'submitted', name);
    assert.equal(s.model.doGenerateCalls.length, 1, `${name}: built-in runner took over`);
    assert.equal((s.db.tasks.get(s.task.id)!.output as unknown as TaskOutput).summary, 'built-in output');
    assert.equal(activeHermesLease(s.task.id), null, `${name}: lease revoked`);
    const rows = fallbackRows(s.db);
    assert.equal(rows.length, 1, name);
    assert.match(String(rows[0]!.detail.reason), reason, name);
    assert.ok(token.length === 64, name);
    const everything = JSON.stringify([s.deps.logs, s.db.activity, s.db.calls, s.db.usage]);
    assert.ok(!everything.includes(KEY), `${name}: API key never logged`);
    assert.ok(!everything.includes(token), `${name}: run token never logged`);
    assert.equal(s.db.callsOf('finishAgentTurn').length, 1, `${name}: the agent turn is finished once (by the built-in runner)`);
  }
});

test('runtime claude: budget / turn caps fail the task (no fallback); worker shutdown re-queues', async () => {
  const s1 = setup();
  const r1 = await runTask(s1.task, s1.deps, opts(s1.workspacesDir, fakeQuery(async function* () { yield result('error_max_budget_usd', { total_cost_usd: 0.81 }); }).query));
  assert.equal(r1.status, 'budget_exceeded');
  assert.match(String(s1.db.callsOf('failTask')[0]!.args[1]), /stopped: exceeded \$0\.80 task budget/);
  assert.equal(fallbackRows(s1.db).length, 0);
  assert.equal(s1.model.doGenerateCalls.length, 0);
  assert.equal(s1.db.usage[0]!.detail.runtime, 'claude', 'spend is recorded even when the cap stopped the run');

  const s2 = setup();
  const r2 = await runTask(s2.task, s2.deps, opts(s2.workspacesDir, fakeQuery(async function* () { yield result('error_max_turns'); }).query));
  assert.deepEqual(r2, { status: 'failed', reason: 'stopped: exceeded max steps 25', costUsd: 0.014 });

  const s3 = setup();
  const stop = new AbortController();
  const f3 = fakeQuery(async function* (p) {
    stop.abort();
    await new Promise((_, rej) => {
      if (p.options.abortController!.signal.aborted) rej(new Error('aborted'));
      p.options.abortController!.signal.addEventListener('abort', () => rej(new Error('aborted')));
    });
  });
  const r3 = await runTask(s3.task, s3.deps, { ...opts(s3.workspacesDir, f3.query), abortSignal: stop.signal });
  assert.equal(r3.status, 'requeued');
  assert.equal(s3.db.callsOf('requeueTask').length, 1);
  assert.equal(s3.model.doGenerateCalls.length, 0);
});

test('runtime claude: plain final text and ask_ceo json are saved like Hermes answers', async () => {
  const s = setup();
  await runTask(s.task, s.deps, opts(s.workspacesDir, fakeQuery(async function* () { yield success('```json\n{"ask_ceo": {"question": "Which theme?", "options": ["Dawn", "Impact"]}}\n```'); }).query));
  assert.equal(s.db.tasks.get(s.task.id)!.status, 'awaiting_ceo');
  assert.deepEqual(s.db.callsOf('askCeo')[0]!.args.slice(1), ['Which theme?', ['Dawn', 'Impact']]);

  const s2 = setup();
  const r = await runTask(s2.task, s2.deps, opts(s2.workspacesDir, fakeQuery(async function* () { yield success('Here is the section.'); }).query));
  assert.deepEqual(r, { status: 'submitted', costUsd: 0.014, fallback: true });
});

test('claudeBudget / priceRun / claudeProcessEnv / redact', async () => {
  const s = setup({ spend: { monthlyBudgetUsd: 30, spentThisMonthUsd: 29.5, dailyBudgetUsd: null, spentTodayUsd: 0 } });
  assert.deepEqual(await claudeBudget(s.deps, { maxSteps: 25, maxCostUsd: 1.5 }), { capUsd: 0.5 });
  const noSpend = { ...s.deps, spend: undefined, monthlyBudgetUsd: 10 };
  assert.deepEqual(await claudeBudget(noSpend, { maxSteps: 25, maxCostUsd: 1.5 }), { capUsd: 1.5 }, 'DB month spend when the picker is not wired');
  assert.match(String((await claudeBudget({ ...noSpend, monthlyBudgetUsd: 0 }, { maxSteps: 1, maxCostUsd: 1 }) as { reason: string }).reason), /MONTHLY_BUDGET_USD is 0/);

  const perMsg = new Map([['msg_1', { model: 'claude-haiku-4-5', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }]]);
  const p = priceRun(null, perMsg, 'claude-sonnet-5');
  assert.deepEqual([p.model, p.usage.inputTokens, p.usage.outputTokens, p.costUsd, p.sdkCostUsd], ['claude-haiku-4-5', 1000, 100, 0.0015, null]);

  const env = claudeProcessEnv(KEY, '/tmp/h', { PATH: '/bin', GITHUB_TOKEN: 'ghp_x', SUPABASE_URL: 'https://x', LANG: 'C.UTF-8' });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'HOME', 'LANG', 'PATH', 'USERPROFILE']);
  assert.equal(redact(`a ${KEY} b`, [KEY]), 'a [redacted] b');
  const ws = claudeProcessEnv(KEY, '/tmp/h', { ANTHROPIC_WORKSPACE_ID: 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ' });
  assert.equal(ws.ANTHROPIC_CUSTOM_HEADERS, 'anthropic-workspace-id: wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ');
  assert.equal(claudeProcessEnv(KEY, '/tmp/h', { ANTHROPIC_WORKSPACE_ID: 'bad value' }).ANTHROPIC_CUSTOM_HEADERS, undefined);
});
