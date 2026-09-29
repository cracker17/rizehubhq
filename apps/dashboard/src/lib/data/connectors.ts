import 'server-only';
// Admin → Connectors data (docs/15): connected accounts (metadata only; the secret columns aren't readable by the
// browser role), who may use them, and whether the CEO has 2FA (the forms show the code field up front).
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { totpState } from '@/lib/auth/mfaServer';
import { demoSnapshot } from '@/lib/mock';

export type ConnectorStatus = 'active' | 'needs_reauth' | 'error' | 'disabled';
export type GmailMode = 'read' | 'read_draft' | 'read_draft_send';

export interface ToolView {
  name: string; description: string; policy: 'allow' | 'ask' | 'off'; locked: 'money' | 'contact' | null; badges: string[]; review: boolean;
}

export interface ConnectorView {
  id: string;
  catalog: string | null;
  url: string | null;
  tools: ToolView[];
  kind: 'gmail' | 'mcp';
  name: string;
  account_email: string | null;
  status: ConnectorStatus;
  mode: GmailMode;
  agents: string[];
  last_checked_at: string | null;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface ConnectorsPage {
  mode: 'demo' | 'live';
  connectors: ConnectorView[];
  agents: { id: string; name: string }[];
  totpOn: boolean;
  error?: string;
}

const COLS = 'id,kind,catalog_key,name,account_email,url,status,settings,last_checked_at,last_used_at,last_error,created_at';

export async function loadConnectors(): Promise<ConnectorsPage> {
  if (!supabaseEnv()) {
    const agents = demoSnapshot().agents.map((a) => ({ id: a.id, name: a.name }));
    return {
      mode: 'demo', agents, totpOn: false,
      connectors: [{
        id: 'demo-gmail', kind: 'gmail', catalog: 'gmail', url: null, tools: [], name: 'Main inbox', account_email: 'you@gmail.com', status: 'active', mode: 'read',
        agents: ['coo', 'sales'], last_checked_at: new Date().toISOString(), last_used_at: null, last_error: null, created_at: new Date().toISOString(),
      }, {
        id: 'demo-magnific', kind: 'mcp', catalog: 'magnific', url: 'https://mcp.magnific.com', name: 'Magnific', account_email: null, status: 'active', mode: 'read',
        agents: ['designer'], last_checked_at: new Date().toISOString(), last_used_at: null, last_error: null, created_at: new Date().toISOString(),
        tools: [
          { name: 'search_stock', description: 'Search stock photos, vectors and videos.', policy: 'allow', locked: null, badges: [], review: false },
          { name: 'generate_image', description: 'Generate an image from a prompt. Spends credits.', policy: 'ask', locked: null, badges: ['credits'], review: false },
          { name: 'upscale_image', description: 'Upscale an image up to 16x.', policy: 'off', locked: null, badges: ['credits'], review: true },
        ],
      }],
    };
  }
  const db = (await createSupabaseServer())!;
  const [rows, grants, agents, state, tools] = await Promise.all([
    db.from('connectors').select(COLS).order('created_at'),
    db.from('connector_grants').select('connector_id,agent_id'),
    db.from('agents').select('id,name').eq('enabled', true).order('name'),
    totpState(db),
    db.from('connector_tools').select('connector_id,name,description,policy,locked_reason,badges,review_needed').order('name'),
  ]);
  const toolsBy = new Map<string, ToolView[]>();
  for (const t of (tools.data ?? []) as { connector_id: string; name: string; description: string; policy: ToolView['policy']; locked_reason: ToolView['locked']; badges: string[]; review_needed: boolean }[]) {
    toolsBy.set(t.connector_id, [...(toolsBy.get(t.connector_id) ?? []), { name: t.name, description: t.description, policy: t.policy, locked: t.locked_reason, badges: t.badges ?? [], review: t.review_needed }]);
  }
  const byConnector = new Map<string, string[]>();
  for (const g of (grants.data ?? []) as { connector_id: string; agent_id: string }[]) {
    byConnector.set(g.connector_id, [...(byConnector.get(g.connector_id) ?? []), g.agent_id]);
  }
  return {
    mode: 'live',
    totpOn: Boolean(state?.factorId),
    agents: (agents.data ?? []) as { id: string; name: string }[],
    connectors: ((rows.data ?? []) as (Omit<ConnectorView, 'mode' | 'agents' | 'catalog' | 'tools'> & { catalog_key: string | null; settings: { mode?: GmailMode } | null })[]).map((r) => ({
      id: r.id, kind: r.kind, catalog: r.catalog_key, url: r.url, tools: toolsBy.get(r.id) ?? [], name: r.name, account_email: r.account_email, status: r.status,
      mode: r.settings?.mode === 'read_draft_send' || r.settings?.mode === 'read_draft' ? r.settings.mode : 'read', agents: byConnector.get(r.id) ?? [],
      last_checked_at: r.last_checked_at, last_used_at: r.last_used_at, last_error: r.last_error, created_at: r.created_at,
    })),
    error: rows.error?.message ?? grants.error?.message,
  };
}
