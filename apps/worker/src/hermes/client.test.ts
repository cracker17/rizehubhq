import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HermesClient, HermesError, parseChatCompletion } from './client';
import { envSuffix, hermesAgentConfig, hermesFallbackEnabled, mcpTokenMap } from './config';
import { completion, deadUrl, startMockHermes } from './testServer';

const KEY = 'test-hermes-api-server-key';

test('client: cancel(sessionId) aborts that session\'s in-flight chat (best effort, never throws)', async () => {
  const srv = await startMockHermes(() => 'hang');
  try {
    const c = new HermesClient({ url: srv.url, key: KEY, timeoutMs: 5_000 });
    assert.equal(c.cancel('nothing-running'), 0);
    const p = c.chat({ messages: [{ role: 'user', content: 'hi' }], sessionId: 'task-9', sessionKey: 'writer' });
    while (!srv.seen.length) await new Promise((r) => setTimeout(r, 5));
    assert.equal(c.cancel('other-task'), 0);
    assert.equal(c.cancel('task-9'), 1);
    await assert.rejects(p, (e: unknown) => e instanceof HermesError && e.kind === 'aborted' && /cancelled by HQ/.test(e.message));
    assert.equal(c.cancel('task-9'), 0, 'nothing left to cancel');
  } finally { await srv.close(); }
});

test('client: /health and /v1/chat/completions with bearer key + session headers', async () => {
  const srv = await startMockHermes((r) => {
    if (r.headers.authorization !== `Bearer ${KEY}`) return [401, { error: 'no' }];
    if (r.path === '/health') return [200, { status: 'ok' }];
    return [200, completion('Final answer', { prompt_tokens: 1200, completion_tokens: 300 })];
  });
  try {
    const c = new HermesClient({ url: `${srv.url}/`, key: KEY });
    assert.deepEqual(await c.health(), { status: 'ok' });
    const r = await c.chat({ messages: [{ role: 'user', content: 'hi' }], sessionId: 'task-1', sessionKey: 'writer' });
    assert.equal(r.text, 'Final answer');
    assert.equal(r.model, 'claude-sonnet-5');
    assert.deepEqual(r.usage, { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0 });
    const chat = srv.seen.find((s) => s.path === '/v1/chat/completions')!;
    assert.equal(chat.method, 'POST');
    assert.equal(chat.headers['x-hermes-session-id'], 'task-1');
    assert.equal(chat.headers['x-hermes-session-key'], 'writer');
    assert.deepEqual((chat.body as { messages: unknown }).messages, [{ role: 'user', content: 'hi' }]);
    assert.equal((chat.body as { stream: boolean }).stream, false);
  } finally { await srv.close(); }
});

test('client: 401 → unauthorized, 503 → down, 500 → bad_response, invalid body → bad_response', async () => {
  let status = 401;
  const srv = await startMockHermes(() => [status, status === 200 ? { choices: [] } : { error: 'x' }]);
  try {
    const c = new HermesClient({ url: srv.url, key: 'wrong' });
    const kind = async () => (await c.chat({ messages: [], sessionId: 's', sessionKey: 'k' }).catch((e: HermesError) => e)) as HermesError;
    assert.equal((await kind()).kind, 'unauthorized');
    assert.equal((await c.health().catch((e: HermesError) => e) as HermesError).kind, 'unauthorized');
    status = 503; assert.equal((await kind()).kind, 'down');
    status = 500; assert.equal((await kind()).kind, 'bad_response');
    status = 200; assert.equal((await kind()).kind, 'bad_response');
  } finally { await srv.close(); }
});

test('client: our deadline → timeout; caller abort → aborted; nothing listening → down', async () => {
  const srv = await startMockHermes(() => 'hang');
  try {
    const c = new HermesClient({ url: srv.url, key: KEY });
    const t = await c.chat({ messages: [], sessionId: 's', sessionKey: 'k', timeoutMs: 100 }).catch((e: HermesError) => e) as HermesError;
    assert.ok(t instanceof HermesError);
    assert.equal(t.kind, 'timeout');
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const a = await c.chat({ messages: [], sessionId: 's', sessionKey: 'k', signal: ctrl.signal, timeoutMs: 5_000 }).catch((e: HermesError) => e) as HermesError;
    assert.equal(a.kind, 'aborted');
  } finally { await srv.close(); }
  const down = await new HermesClient({ url: await deadUrl(), key: KEY }).health().catch((e: HermesError) => e) as HermesError;
  assert.equal(down.kind, 'down');
});

test('parseChatCompletion: content parts are joined; cached tokens read', () => {
  const r = parseChatCompletion({ model: 'm', choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } });
  assert.equal(r.text, 'ab');
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 });
});

test('config: per-agent env names, fallback flag, MCP token map', () => {
  assert.equal(envSuffix('web-dev'), 'WEB_DEV');
  const env = {
    HERMES_URL_WEB_DEV: 'http://hermes-web-dev:8642/', HERMES_KEY_WEB_DEV: 'k1', HERMES_MODEL: 'claude-sonnet-5', HERMES_MODEL_WEB_DEV: 'claude-opus-5-5',
    HERMES_URL_WRITER: 'http://hermes-writer:8642', HQ_MCP_TOKEN_WRITER: 'w'.repeat(40), HQ_MCP_TOKEN_SALES: 'short',
    HQ_MCP_TOKEN_DESIGNER: 'd'.repeat(40), HQ_MCP_TOKEN_WEB_DEV: 'd'.repeat(40),
  };
  assert.deepEqual(hermesAgentConfig('web-dev', env), { agentId: 'web-dev', url: 'http://hermes-web-dev:8642', key: 'k1', timeoutMs: 30 * 60_000, model: 'claude-opus-5-5' });
  assert.equal(hermesAgentConfig('writer', env), null, 'no key → not configured');
  assert.equal(hermesFallbackEnabled({}), true);
  assert.equal(hermesFallbackEnabled({ HERMES_FALLBACK: 'off' }), false);
  const m = mcpTokenMap(['web-dev', 'designer', 'writer', 'sales'], env);
  assert.deepEqual([...m.values()], ['writer'], 'short and duplicated tokens are ignored');
});
