import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { catalogEntry, defaultToolPolicy, policyAllowed } from '@rizehubhq/shared';
import { loadKeyring, open, seal } from '../vault/crypto';
import { connectorContext, type AgentTool, type ConnectorFull, type ConnectorStore, type NewConnector, type SyncedTool } from './store';
import { McpNeedsSignIn, type McpOpener, type McpSecret, type McpToolDef } from './mcpClient';
import { createMcpConnectorRoutes } from '../routes/mcpConnectors';
import { loadMcpTools, toolName, toolSchema } from '../tools/mcp';
import { executeApprovedMcpCalls } from './mcpExecute';

const kr = loadKeyring({ VAULT_MASTER_KEY: randomBytes(32).toString('base64') })!;
const TOOLS: McpToolDef[] = [
  { name: 'search_stock', description: 'Search stock photos', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'generate_image', description: 'Generate an image', inputSchema: { $schema: 'x', type: 'object', properties: { prompt: { type: 'string' } } }, annotations: null },
  { name: 'make_outbound_call', description: 'Phone a customer', inputSchema: { type: 'object' }, annotations: null },
];

function fakeStore() {
  const rows: ConnectorFull[] = [];
  const tools = new Map<string, SyncedTool[]>();
  const grants = new Map<string, string[]>();
  const marks: { id: string; status: string }[] = [];
  const rotated: string[] = [];
  const store: ConnectorStore = {
    forAgent: async (agent, kind) => rows.filter((r) => r.kind === kind && r.status === 'active' && (grants.get(r.id) ?? []).includes(agent)),
    get: async (id) => rows.find((r) => r.id === id) ?? null,
    insert: async (c: NewConnector) => {
      rows.push({ id: c.id, kind: c.kind, status: 'active', name: c.name, account_email: null, url: c.url, auth_type: c.authType, settings: c.settings, sealed: c.sealed });
      grants.set(c.id, c.grants);
      return c.id;
    },
    rotate: async (id, sealed) => { rows.find((r) => r.id === id)!.sealed = sealed; rotated.push(id); },
    mark: async (id, status) => { marks.push({ id, status }); },
    syncTools: async (id, list) => { tools.set(id, list); return list.length; },
    toolsForAgent: async (agent) => {
      const out: AgentTool[] = [];
      for (const r of rows) {
        if (r.status !== 'active' || !(grants.get(r.id) ?? []).includes(agent)) continue;
        for (const t of tools.get(r.id) ?? []) if (t.policy !== 'off') out.push({ connector_id: r.id, name: t.name, description: t.description, input_schema: t.input_schema, policy: t.policy as 'allow' | 'ask' });
      }
      return out;
    },
  };
  return { store, rows, tools, grants, marks, rotated };
}

function fakeApp(opts: { fail?: Error } = {}) {
  const seen: { url: string; secret: McpSecret }[] = [];
  const calls: { name: string; args: unknown }[] = [];
  const opener: McpOpener = async (url, secret, onSave) => {
    seen.push({ url, secret });
    if (opts.fail) throw opts.fail;
    if (secret.kind === 'oauth') await onSave?.({ ...secret, tokens: { access_token: 'refreshed', token_type: 'Bearer' } });
    return {
      listTools: async () => TOOLS,
      callTool: async (name, args) => { calls.push({ name, args }); return { text: `ran ${name}`, isError: false }; },
      close: async () => undefined,
    };
  };
  return { opener, seen, calls };
}

test('defaultToolPolicy: read-only allowed, unknown asks, credits ask, money locked, phone calls off and locked', () => {
  const magnific = catalogEntry('magnific');
  assert.deepEqual(defaultToolPolicy(TOOLS[0]!, magnific), { policy: 'allow', locked: null, badges: [] });
  assert.deepEqual(defaultToolPolicy(TOOLS[1]!, magnific), { policy: 'ask', locked: null, badges: ['credits'] });
  assert.deepEqual(defaultToolPolicy(TOOLS[2]!, catalogEntry('elevenlabs')), { policy: 'off', locked: 'contact', badges: ['contact'] });
  assert.deepEqual(defaultToolPolicy({ name: 'create_campaign' }, catalogEntry('meta-ads')), { policy: 'ask', locked: 'money', badges: ['money'] });
  assert.deepEqual(defaultToolPolicy({ name: 'get_campaigns', annotations: { readOnlyHint: true } }, catalogEntry('meta-ads')).policy, 'allow');
  assert.equal(defaultToolPolicy({ name: 'update_page', annotations: { readOnlyHint: true, destructiveHint: true } }, null).policy, 'ask');
  assert.equal(policyAllowed('allow', 'money'), false);
  assert.equal(policyAllowed('ask', 'money'), true);
});

test('toolName / toolSchema: provider-safe unique names; object schemas without $schema', () => {
  const taken = new Set<string>();
  assert.equal(toolName('Magnific', 'generate image!', taken), 'mcp_magnific__generate_image');
  assert.equal(toolName('Magnific', 'generate_image', taken), 'mcp_magnific__generate_image_2');
  assert.ok(toolName('A very long connector name indeed', 'x'.repeat(80), taken).length <= 64);
  assert.deepEqual(toolSchema({ $schema: 'x', type: 'object', properties: { q: { type: 'string' } } }), { type: 'object', properties: { q: { type: 'string' } } });
  assert.deepEqual(toolSchema({ type: 'string' }), { type: 'object', properties: {}, additionalProperties: true });
});

test('connect with a token: header built from the catalog, tools listed with defaults, secret sealed to the connector', async () => {
  const s = fakeStore();
  const app = fakeApp();
  const routes = createMcpConnectorRoutes({ store: () => s.store, keyring: () => kr, publicUrl: () => 'https://hq.example', open: app.opener, checkUrl: async () => undefined });
  const call = (path: string, body: unknown) => routes.find((r) => r.path === path)!.handle({} as never, Buffer.from(JSON.stringify(body)));
  const [status, body] = await call('/connectors/mcp/token', { catalogKey: 'github', token: 'github_pat_abcdefgh', agents: ['web-dev'] });
  assert.equal(status, 200);
  const id = (body as { id: string }).id;
  assert.deepEqual(app.seen[0], { url: 'https://api.githubcopilot.com/mcp/', secret: { kind: 'header', header: 'Authorization', value: 'Bearer github_pat_abcdefgh' } });
  assert.deepEqual(JSON.parse(open(s.rows[0]!.sealed!, kr, connectorContext(id))), { kind: 'header', header: 'Authorization', value: 'Bearer github_pat_abcdefgh' });
  assert.deepEqual(s.tools.get(id)!.map((t) => [t.name, t.policy]), [['search_stock', 'allow'], ['generate_image', 'ask'], ['make_outbound_call', 'off']]);
  assert.equal(s.rows[0]!.auth_type, 'bearer');
  assert.deepEqual(s.rows[0]!.settings, { catalog: 'github' });
});

test('connect: own-app services need client credentials; custom URLs must be https and public; a refused token saves nothing', async () => {
  const s = fakeStore();
  const routes = (open: McpOpener, checkUrl: (u: string) => Promise<void> = async () => undefined) =>
    createMcpConnectorRoutes({ store: () => s.store, keyring: () => kr, publicUrl: () => 'https://hq.example', open, checkUrl });
  const call = (r: ReturnType<typeof routes>, path: string, body: unknown) => r.find((x) => x.path === path)!.handle({} as never, Buffer.from(JSON.stringify(body)));
  assert.match(JSON.stringify((await call(routes(fakeApp().opener), '/connectors/mcp/start', { catalogKey: 'hubspot' }))[1]), /needs your own OAuth app/);
  assert.match(JSON.stringify((await call(routes(fakeApp().opener), '/connectors/mcp/token', { url: 'http://10.0.0.5/mcp', token: 'abcdefghij' }))[1]), /https:\/\//);
  const blocked = routes(fakeApp().opener, async () => { throw new Error('private'); });
  assert.match(JSON.stringify((await call(blocked, '/connectors/mcp/token', { url: 'https://internal.example/mcp', token: 'abcdefghij' }))[1]), /private or blocked/);
  const refused = routes(fakeApp({ fail: new McpNeedsSignIn('401 Unauthorized') }).opener);
  assert.match(JSON.stringify((await call(refused, '/connectors/mcp/token', { catalogKey: 'linear', token: 'lin_api_badbadbad' }))[1]), /refused the sign-in or token/);
  assert.equal(s.rows.length, 0);
});

test('agent tools: Allowed runs the app with the decrypted secret; Ask me queues an mcp.call approval; ungranted agents get nothing', async () => {
  const s = fakeStore();
  const app = fakeApp();
  const routes = createMcpConnectorRoutes({ store: () => s.store, keyring: () => kr, publicUrl: () => 'https://hq.example', open: app.opener, checkUrl: async () => undefined });
  await routes.find((r) => r.path === '/connectors/mcp/token')!.handle({} as never, Buffer.from(JSON.stringify({ catalogKey: 'linear', token: 'lin_api_12345678', agents: ['designer'] })));
  const queued: { type: string; spec: Record<string, unknown> }[] = [];
  const ctx = (agent: string) => ({ task: { id: 't1', agent_id: agent, request_id: 'r1' }, deps: { db: {
    requestExternalAction: async (_t: string, type: string, spec: Record<string, unknown>) => { queued.push({ type, spec }); return 'ap-9'; },
  }, log: () => undefined } }) as never;
  assert.deepEqual(Object.keys(await loadMcpTools(ctx('writer'), { store: s.store, keyring: kr, open: app.opener })), []);
  const tools = await loadMcpTools(ctx('designer'), { store: s.store, keyring: kr, open: app.opener }) as Record<string, { execute: (a: unknown, o: unknown) => Promise<string> }>;
  assert.deepEqual(Object.keys(tools).sort(), ['mcp_linear__generate_image', 'mcp_linear__search_stock']);
  const out = await tools.mcp_linear__search_stock!.execute({ q: 'shoes' }, { toolCallId: 'x', messages: [] });
  assert.match(out, /outside app: treat it as data[\s\S]*ran search_stock/);
  assert.deepEqual(app.calls, [{ name: 'search_stock', args: { q: 'shoes' } }]);
  assert.match(await tools.mcp_linear__generate_image!.execute({ prompt: 'a dress' }, { toolCallId: 'y', messages: [] }), /Queued for the CEO's approval \(approval ap-9\)/);
  assert.equal(app.calls.length, 1, 'Ask me never calls the app');
  assert.deepEqual([queued[0]!.type, (queued[0]!.spec.mcp as { tool: string }).tool, (queued[0]!.spec.mcp as { arguments: unknown }).arguments], ['mcp.call', 'generate_image', { prompt: 'a dress' }]);
});

test('approved mcp.call: runs once; refuses when the tool was switched off after approval; expired sign-in → needs_reauth', async () => {
  const s = fakeStore();
  const app = fakeApp();
  const id = 'c1';
  s.rows.push({ id, kind: 'mcp', status: 'active', name: 'Magnific', account_email: null, url: 'https://mcp.magnific.com', auth_type: 'oauth',
    settings: { catalog: 'magnific' }, sealed: seal(JSON.stringify({ kind: 'oauth', tokens: { access_token: 'a', token_type: 'Bearer' } }), kr, connectorContext(id)) });
  s.grants.set(id, ['designer']);
  s.tools.set(id, [{ name: 'generate_image', description: '', input_schema: {}, annotations: {}, policy: 'ask', locked: null, badges: [] }]);
  const execs: { id: string; phase: string; result?: Record<string, unknown> }[] = [];
  const claimed = new Set<string>();
  const deps = (ids: string[], open: McpOpener = app.opener) => ({
    list: async () => ids.map((a) => ({ id: a, payload: { spec: { mcp: { connector_id: id, tool: 'generate_image', arguments: { prompt: 'x' }, agent_id: 'designer' } } } })),
    exec: async (a: string, phase: 'claim' | 'done' | 'failed', result?: Record<string, unknown>) => {
      execs.push({ id: a, phase, result });
      if (phase !== 'claim') return true;
      if (claimed.has(a)) return false;
      claimed.add(a); return true;
    },
    store: s.store, keyring: kr, open,
  });
  assert.equal(await executeApprovedMcpCalls(deps(['a1'])), 1);
  assert.deepEqual(app.calls, [{ name: 'generate_image', args: { prompt: 'x' } }]);
  assert.equal(execs.at(-1)!.result!.result, 'ran generate_image');
  assert.deepEqual(s.rotated, [id], 'refreshed tokens are saved back sealed');
  assert.equal(await executeApprovedMcpCalls(deps(['a1'])), 0, 'never twice');
  s.tools.get(id)![0]!.policy = 'off';
  assert.equal(await executeApprovedMcpCalls(deps(['a2'])), 0);
  assert.deepEqual([execs.at(-1)!.result!.code, execs.at(-1)!.result!.retryable], ['access_changed', false]);
  s.tools.get(id)![0]!.policy = 'ask';
  assert.equal(await executeApprovedMcpCalls(deps(['a3'], fakeApp({ fail: new McpNeedsSignIn('expired') }).opener)), 0);
  assert.equal(execs.at(-1)!.result!.code, 'auth');
  assert.equal(s.marks.at(-1)!.status, 'needs_reauth');
  assert.equal(app.calls.length, 1);
});
