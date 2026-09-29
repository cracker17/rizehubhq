// Runs the MCP tool calls the CEO approved (mcp.call approvals queued by "Ask me" app tools, tools/mcp.ts). Exactly once
// (external_action_exec claim → done/failed, max 3 attempts). Right before running it re-checks that the app is still
// connected and granted to the agent, and the tool is still on (not Off, not awaiting review); otherwise it refuses.
import type { SupabaseClient } from '@supabase/supabase-js';
import { open, seal, type Keyring } from '../vault/crypto';
import { connectorContext, type ConnectorStore } from './store';
import { isAuthFailure, type McpOpener, type McpSecret } from './mcpClient';

export interface McpCallSpec { connector_id: string; tool: string; arguments: Record<string, unknown>; agent_id: string }
export interface McpApproval { id: string; payload: { attempts?: number; last_error?: { retryable?: boolean }; spec?: { mcp?: McpCallSpec } } }

export interface McpExecDeps {
  list: () => Promise<McpApproval[]>;
  exec: (approvalId: string, phase: 'claim' | 'done' | 'failed', result?: Record<string, unknown>) => Promise<boolean>;
  store: ConnectorStore;
  keyring: Keyring | null;
  open: McpOpener;
  log?: (msg: string) => void;
}

const MAX_ATTEMPTS = 3;
const refuse = (code: string, message: string) => ({ code, message, retryable: false });

export async function executeApprovedMcpCalls(d: McpExecDeps): Promise<number> {
  let ran = 0;
  for (const ap of await d.list()) {
    const spec = ap.payload.spec?.mcp;
    if (Number(ap.payload.attempts ?? 0) >= MAX_ATTEMPTS || ap.payload.last_error?.retryable === false) continue;
    if (!(await d.exec(ap.id, 'claim'))) continue;
    if (!spec?.connector_id || !spec.tool) { await d.exec(ap.id, 'failed', refuse('bad_spec', 'The approval has no app call.')); continue; }
    const c = await d.store.get(spec.connector_id);
    if (!c || c.kind !== 'mcp' || c.status !== 'active' || !c.url || !c.sealed) {
      await d.exec(ap.id, 'failed', refuse('app_unavailable', 'That app is no longer connected and active. Nothing ran.')); continue;
    }
    const tools = (await d.store.toolsForAgent?.(spec.agent_id)) ?? [];
    if (!tools.some((t) => t.connector_id === c.id && t.name === spec.tool)) {
      await d.exec(ap.id, 'failed', refuse('access_changed', `${c.name} → ${spec.tool} is no longer allowed for this agent. Nothing ran.`)); continue;
    }
    if (!d.keyring) { await d.exec(ap.id, 'failed', { code: 'no_keyring', message: 'VAULT_MASTER_KEY is not set on the worker.', retryable: true }); continue; }
    const kr = d.keyring;
    try {
      const secret = JSON.parse(open(c.sealed, kr, connectorContext(c.id))) as McpSecret;
      const session = await d.open(c.url, secret, async (s) => { await d.store.rotate(c.id, seal(JSON.stringify(s), kr, connectorContext(c.id))); });
      try {
        const r = await session.callTool(spec.tool, spec.arguments ?? {});
        await d.store.mark(c.id, 'active', null, true).catch(() => undefined);
        await d.exec(ap.id, 'done', { app: c.name, tool: spec.tool, is_error: r.isError, result: r.text.slice(0, 4000), ran_at: new Date().toISOString() });
        ran++;
        d.log?.(`[mcp] ran ${c.name} → ${spec.tool} (approval ${ap.id})`);
      } finally { await session.close(); }
    } catch (e) {
      const auth = isAuthFailure(e);
      if (auth) await d.store.mark(c.id, 'needs_reauth', 'The sign-in expired. Reconnect this app.').catch(() => undefined);
      const message = auth ? 'The app sign-in expired: reconnect it in Admin → Connectors, then ask the agent again.' : (e instanceof Error ? e.message : String(e)).slice(0, 300);
      await d.exec(ap.id, 'failed', { code: auth ? 'auth' : 'mcp_error', message, retryable: !auth }).catch(() => false);
      d.log?.(`[mcp] approval ${ap.id} failed: ${message}`);
    }
  }
  return ran;
}

/** Approved mcp.call approvals of the last 14 days that haven't run yet (service role). */
export function listApprovedMcpCalls(sb: SupabaseClient, limit = 10) {
  return async (): Promise<McpApproval[]> => {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const { data, error } = await sb.from('approvals').select('id,payload').eq('kind', 'external_action').eq('status', 'approved')
      .eq('payload->>action_type', 'mcp.call').gte('decided_at', since).order('decided_at').limit(limit * 4);
    if (error) throw new Error(`approvals: ${error.message}`);
    return ((data ?? []) as McpApproval[]).filter((a) => !('executed_at' in (a.payload ?? {}))).slice(0, limit);
  };
}
