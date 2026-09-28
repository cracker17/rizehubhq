// HQ MCP tool server for Hermes agents (docs/05 "Hermes runtime"): MCP over Streamable HTTP, stateless, JSON
// responses only (no SSE stream). Minimal JSON-RPC 2.0: initialize, notifications/*, ping, tools/list, tools/call.
//
//   POST /mcp   Authorization: Bearer <HQ_MCP_TOKEN_<AGENT>>
//     token → agent identity → only that role's tools (runner.buildTools with the role file's tool list).
//     tools/call runs against the agent's CURRENT task (agents.current_task_id, or the `task_id` argument when given),
//     which must be a `working` task of that same agent. Hermes' MCP headers are static, so the task is resolved
//     server-side. Every call must also carry `run_id`, the lease of the Hermes attempt HQ started (hermes/mcpState.ts):
//     once HQ revokes it (fallback to the built-in runner, run ended, newer attempt) calls are refused and change nothing. Approval-gated tools behave exactly as in the built-in runner: they create approvals, never act.
//     Every call is written to activity_log (action mcp.tool_call; tool name, ok, ms; never the arguments).
//   GET  /mcp   405 (this server offers no server-initiated stream)
import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { asSchema, type Tool, type ToolSet } from 'ai';
import type { TaskRow } from '../hqdb';
import type { Route } from '../routes/types';
import { buildTools } from '../runner';
import { errMsg, log, type WorkerDeps } from '../deps';
import type { RunState } from '../runner';
import { enterHermesLease } from './mcpState';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_SERVER_INFO = { name: 'rizehub-hq', version: '1.0.0' };
export const MCP_MAX_BODY = 256 * 1024;

type Id = string | number | null;
interface RpcRequest { jsonrpc?: string; id?: Id; method?: unknown; params?: unknown }
type RpcResponse = { jsonrpc: '2.0'; id: Id; result: unknown } | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string } };

export interface HqMcpOptions {
  /** Worker deps (set by index.ts at startup); null → 503. */
  deps: () => WorkerDeps | null;
  /** token → agent id (hermes/config.ts mcpTokenMap). */
  tokens: () => Map<string, string>;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Bearer token → agent id (constant-time compare against every configured token). */
export function agentForToken(header: string | string[] | undefined, tokens: Map<string, string>): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h ?? '');
  if (!m) return null;
  let found: string | null = null;
  for (const [t, agent] of tokens) if (same(m[1]!, t)) found = agent;
  return found;
}

const isStub = (t: Tool) => String(t.description ?? '').includes('(not connected yet)');

/** A placeholder task so tool definitions can be listed without an active task (executes are never called on it). */
function listingTask(agentId: string): TaskRow {
  return {
    id: '00000000-0000-4000-8000-000000000000', request_id: '00000000-0000-4000-8000-000000000000', client_id: null, agent_id: agentId,
    title: '', instructions: '', work_type: '', acceptance_criteria: [], status: 'working', revision_count: 0, max_revisions: 0,
    qa_feedback: null, output: null,
  };
}

/** Tool state for definitions only (listing / name checks); executes never run against it. */
const listingState = (): RunState => ({ ended: null, costUsd: 0, overBudget: false, toolErrors: 0 });

function roleTools(deps: WorkerDeps, agentId: string, task: TaskRow, state: RunState = listingState()): ToolSet {
  const role = deps.loadRole(agentId);
  const tools = buildTools({ task, role, deps, state });
  return Object.fromEntries(Object.entries(tools).filter(([, t]) => !isStub(t)));
}

const TASK_ID_PROP = { type: 'string', description: 'HQ task id you are working on (given in your task prompt). Optional: defaults to your current task.' };
const RUN_ID_PROP = { type: 'string', description: 'HQ run id given in your task prompt. Required: calls from a run HQ has ended are refused.' };

async function toolList(deps: WorkerDeps, agentId: string) {
  const tools = roleTools(deps, agentId, listingTask(agentId));
  return Object.entries(tools).map(([name, t]) => {
    const js = { ...(asSchema(t.inputSchema).jsonSchema as Record<string, unknown>) };
    const props = { ...((js.properties as Record<string, unknown> | undefined) ?? {}), task_id: TASK_ID_PROP, run_id: RUN_ID_PROP };
    const required = [...new Set([...((js.required as string[] | undefined) ?? []), 'run_id'])];
    delete js.$schema;
    return { name, description: t.description ?? name, inputSchema: { ...js, type: 'object', properties: props, required } };
  });
}

const textResult = (text: string, isError = false) => ({ content: [{ type: 'text', text }], isError });

/** Resolves the task a tool call acts on: must be a `working` task of this agent. */
async function currentTask(deps: WorkerDeps, agentId: string, explicit: unknown): Promise<TaskRow | string> {
  const agent = await deps.db.getAgent(agentId);
  if (!agent || !agent.enabled) return `Agent ${agentId} is unknown or disabled.`;
  const id = typeof explicit === 'string' && explicit.trim() ? explicit.trim() : agent.current_task_id;
  if (!id) return `No active HQ task for ${agentId}: HQ tools only work while HQ has assigned you a task.`;
  const task = await deps.db.getTask(id).catch(() => null);
  if (!task || task.agent_id !== agentId) return `Task ${id} is not assigned to ${agentId}.`;
  if (task.status !== 'working') return `Task ${id} is ${task.status}, not in progress: stop working on it.`;
  return task;
}

async function callTool(deps: WorkerDeps, agentId: string, params: unknown) {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof p.name !== 'string') throw new RpcError(-32602, 'tools/call needs params.name');
  const args = { ...((p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>) };
  const explicitTask = args.task_id;
  const runId = typeof args.run_id === 'string' && args.run_id.trim() ? args.run_id.trim() : null;
  delete args.task_id;
  delete args.run_id;

  // Unknown tool names are protocol errors (checked before touching the task).
  const listed = roleTools(deps, agentId, listingTask(agentId));
  if (!listed[p.name]) throw new RpcError(-32602, `Unknown tool "${p.name}" for ${agentId}`);

  const task = await currentTask(deps, agentId, explicitTask);
  if (typeof task === 'string') return textResult(task, true);
  // The run lease: refused (nothing executed) once HQ revoked this Hermes attempt, e.g. after a fallback.
  const lease = enterHermesLease(task.id, agentId, runId);
  if (typeof lease === 'string') {
    await deps.db.logActivity(agentId, 'mcp.tool_refused', task.request_id, task.id, { tool: p.name, via: 'hermes', run_id: runId })
      .catch((e) => log(deps, `[mcp] activity log failed`, errMsg(e)));
    return textResult(lease, true);
  }

  const started = Date.now();
  let ok = false;
  try {
    const t = roleTools(deps, agentId, task, lease.state)[p.name]!;
    const schema = asSchema(t.inputSchema);
    const v = schema.validate ? await schema.validate(args) : { success: true as const, value: args };
    if (!v.success) return textResult(`Invalid arguments for ${p.name}: ${errMsg(v.error).slice(0, 500)}`, true);
    if (!t.execute) return textResult(`${p.name} cannot be executed here.`, true);
    const out: unknown = await t.execute(v.value, { toolCallId: `mcp-${started}`, messages: [] });
    ok = true;
    return textResult(typeof out === 'string' ? out : JSON.stringify(out));
  } catch (e) {
    return textResult(`Error: ${errMsg(e).slice(0, 1000)}`, true);
  } finally {
    lease.done();
    await deps.db.logActivity(agentId, 'mcp.tool_call', task.request_id, task.id, { tool: p.name, ok, ms: Date.now() - started, via: 'hermes', run_id: lease.runId })
      .catch((e) => log(deps, `[mcp] activity log failed`, errMsg(e)));
  }
}

class RpcError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

async function handleOne(deps: WorkerDeps, agentId: string, msg: RpcRequest): Promise<RpcResponse | null> {
  const isNotification = msg.id === undefined;
  const id: Id = msg.id ?? null;
  try {
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') throw new RpcError(-32600, 'Invalid Request');
    let result: unknown;
    switch (msg.method) {
      case 'initialize': {
        const asked = (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const version = (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
        result = {
          protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: MCP_SERVER_INFO,
          instructions: `RizeHub HQ tools for ${agentId}. Calls act on your current HQ task; anything that publishes, sends, merges, `
            + 'deploys or spends only creates an approval for the CEO.',
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: await toolList(deps, agentId) }; break;
      case 'tools/call': result = await callTool(deps, agentId, msg.params); break;
      default:
        if (msg.method.startsWith('notifications/')) return null;
        throw new RpcError(-32601, `Method not found: ${msg.method}`);
    }
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  } catch (e) {
    if (isNotification) return null;
    const code = e instanceof RpcError ? e.code : -32603;
    return { jsonrpc: '2.0', id, error: { code, message: e instanceof RpcError ? e.message : `Internal error: ${errMsg(e).slice(0, 300)}` } };
  }
}

/** Returns [status, body]; body undefined = 202 Accepted with no body (notifications only). */
export async function handleMcpPost(o: HqMcpOptions, req: http.IncomingMessage, raw: Buffer): Promise<[number, unknown]> {
  const tokens = o.tokens();
  if (!tokens.size) return [503, { error: 'HQ MCP is not configured (no HQ_MCP_TOKEN_<AGENT> set)' }];
  const agentId = agentForToken(req.headers.authorization, tokens);
  if (!agentId) return [401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }];
  const deps = o.deps();
  if (!deps) return [503, { jsonrpc: '2.0', id: null, error: { code: -32002, message: 'worker is starting' } }];
  if (raw.length > MCP_MAX_BODY) return [413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'body too large' } }];
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return [400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }]; }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as RpcRequest[];
  if (!msgs.length) return [400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }];
  const out: RpcResponse[] = [];
  for (const m of msgs) {
    const r = await handleOne(deps, agentId, m && typeof m === 'object' ? m : {});
    if (r) out.push(r);
  }
  if (!out.length) return [202, undefined];
  return [200, batch ? out : out[0]];
}

export function createHqMcpRoutes(o: HqMcpOptions): Route[] {
  return [
    { method: 'POST', path: '/mcp', auth: 'self', handle: (req, raw) => handleMcpPost(o, req, raw) },
    { method: 'GET', path: '/mcp', auth: 'self', handle: async () => [405, { error: 'no server-initiated stream; POST JSON-RPC to /mcp' }] },
  ];
}

// ---------- deps registry (index.ts sets it once the worker is wired) ----------
let registered: WorkerDeps | null = null;
export function setMcpDeps(deps: WorkerDeps | null): void { registered = deps; }
export function getMcpDeps(): WorkerDeps | null { return registered; }
