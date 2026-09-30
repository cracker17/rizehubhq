// Brain MCP server (docs/16-BRAIN.md "Connector"): MCP over Streamable HTTP, stateless, JSON responses only (same
// minimal JSON-RPC 2.0 as the worker's HQ MCP server, apps/worker/src/hermes/mcp.ts). Reached as
// https://hq.rizehub.ph/mcp/brain through the dashboard, which passes the Authorization header along untouched.
//   Bearer = an OAuth access token (oauth/server.ts). No/invalid token → 401 + WWW-Authenticate pointing at the
//   protected-resource metadata, which is how Claude discovers the sign-in.
//   brain:read  → list/load/search/get/activity/setup kit.   brain:write → save session, update memory, new project.
// Every tool call is written to brain_events (tool name + ok; never the arguments).
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../store/types';
import type { BrainService } from '../service';
import { authenticate, type Caller } from '../oauth/server';
import { createProjectOp, saveSessionOp, updateMemoryOp, WriteError, type NewProject, type SessionInput } from '../write/vault';
import { search, type SearchDeps } from '../queries';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_SERVER_INFO = { name: 'hq-brain', title: 'HQ Brain', version: '1.0.0' };
export const MCP_MAX_BODY = 256 * 1024;
const MAX_TEXT = 60_000;

export interface McpDeps extends SearchDeps {
  store: Store;
  service: BrainService;
  vaultDir: string;
  log: (msg: string) => void;
}

type Id = string | number | null;
interface RpcRequest { jsonrpc?: string; id?: Id; method?: unknown; params?: unknown }
type RpcResponse = { jsonrpc: '2.0'; id: Id; result: unknown } | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string } };
class RpcError extends Error { constructor(public code: number, message: string) { super(message); } }

const str = { type: 'string' } as const;
const lines = (description: string) => ({ type: 'array', items: str, description });
const PROJECT = { type: 'string', description: 'Project slug, name or alias (e.g. "hq-brain", "powerg"). brain_list_projects lists them.' };

interface ToolDef {
  name: string; title: string; description: string; scope: 'brain:read' | 'brain:write';
  inputSchema: Record<string, unknown>; annotations: Record<string, boolean>;
  run: (d: McpDeps, args: Record<string, unknown>, caller: Caller) => Promise<string>;
}

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const cap = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n\n[… cut at ${MAX_TEXT} characters; open the file with brain_get_document]` : s);
const actorOf = (c: Caller) => `claude:${(c.clientName ?? 'connector').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40)}`;

interface ProjectRow { slug: string; name: string; aliases: string[]; status: string | null; last_activity: string | null; sessions: number; open_next_steps: number; listed: boolean }

async function projects(d: McpDeps): Promise<ProjectRow[]> {
  return (await d.store.rpc<ProjectRow[]>('brain_list_projects')) ?? [];
}

/** Slug, name or alias → slug (exact first, then a unique partial match). */
async function resolveSlug(d: McpDeps, ask: unknown): Promise<string> {
  const q = String(ask ?? '').trim().toLowerCase();
  if (!q) throw new WriteError('project is required');
  const all = (await projects(d)).filter((p) => p.listed);
  const hit = (p: ProjectRow, exact: boolean) => [p.slug, p.name.toLowerCase(), ...p.aliases.map((a) => a.toLowerCase())]
    .some((k) => (exact ? k === q : k.includes(q)));
  const exact = all.filter((p) => hit(p, true));
  if (exact.length === 1) return exact[0]!.slug;
  const partial = exact.length ? exact : all.filter((p) => hit(p, false));
  if (partial.length === 1) return partial[0]!.slug;
  if (!partial.length) throw new WriteError(`No project matches "${ask}". Call brain_list_projects to see them all.`);
  throw new WriteError(`"${ask}" matches several projects: ${partial.slice(0, 10).map((p) => `${p.slug} (${p.name})`).join(', ')}. Ask which one.`);
}

const readVaultFile = (d: McpDeps, rel: string) => {
  try { return fs.readFileSync(path.join(d.vaultDir, ...rel.split('/')), 'utf8'); } catch { return null; }
};

export const TOOLS: ToolDef[] = [
  {
    name: 'brain_list_projects', title: 'List projects', scope: 'brain:read', annotations: READ,
    description: "All projects in Julev's memory vault with status and last activity (= /projects).",
    inputSchema: { type: 'object', properties: {} },
    async run(d) {
      const rows = (await projects(d)).filter((p) => p.listed);
      if (!rows.length) return 'The brain has no projects indexed yet.';
      return rows.map((p) => `- **${p.name}** (\`${p.slug}\`) · last ${p.last_activity ?? 'n/a'} · ${p.sessions} sessions · ${p.open_next_steps} open steps`
        + (p.status ? `\n  ${p.status.split('\n')[0]!.replace(/^[-*]\s*/, '').slice(0, 160)}` : '')).join('\n');
    },
  },
  {
    name: 'brain_load_project', title: 'Load a project', scope: 'brain:read', annotations: READ,
    description: "Load a project's memory (= /load): memory.md, its newest session summaries, and Julev's profile. Read this before working on the project, then treat it as the active project for brain_save_session.",
    inputSchema: {
      type: 'object', required: ['project'],
      properties: {
        project: PROJECT,
        sessions: { type: 'integer', minimum: 0, maximum: 10, description: 'How many recent session summaries to include (default 2).' },
        include_profile: { type: 'boolean', description: "Include Julev's profile (default true). Skip it when already read in this chat." },
      },
    },
    async run(d, a) {
      const slug = await resolveSlug(d, a.project);
      const n = Number.isInteger(a.sessions) ? Math.max(0, Math.min(10, a.sessions as number)) : 2;
      const b = await d.store.rpc<null | { project: { name: string; slug: string; last_activity: string | null }; memory: { path: string; body: string } | null; sessions: Array<{ path: string; title: string; doc_date: string | null; body: string }>; documents: Array<{ path: string; kind: string }> }>(
        'brain_project_bundle', { p_slug: slug, p_sessions: n });
      if (!b) throw new WriteError(`Project ${slug} is not indexed yet.`);
      const out = [`# ${b.project.name} (\`${slug}\`) · last activity ${b.project.last_activity ?? 'n/a'}`];
      if (a.include_profile !== false) {
        const prof = await d.store.rpc<null | { body: string }>('brain_get_document', { p_path: 'profile/profile.md' });
        if (prof) out.push(`## Julev's profile (profile/profile.md)\n${prof.body.trim()}`);
      }
      out.push(b.memory ? `## Memory (${b.memory.path})\n${b.memory.body.trim()}` : '## Memory\n(no memory.md yet)');
      for (const s of b.sessions) out.push(`## Session ${s.doc_date ?? ''}: ${s.title} (${s.path})\n${s.body.trim()}`);
      const others = b.documents.filter((x) => x.kind === 'project_doc').map((x) => x.path);
      if (others.length) out.push(`## Other project files (open with brain_get_document)\n${others.map((p) => `- ${p}`).join('\n')}`);
      return cap(out.join('\n\n'));
    },
  },
  {
    name: 'brain_search', title: 'Search the brain', scope: 'brain:read', annotations: READ,
    description: 'Search every project (or one) by meaning and keywords (= /recall). Returns matching passages with their file paths.',
    inputSchema: {
      type: 'object', required: ['query'],
      properties: {
        query: { type: 'string', description: 'What to look for, in plain words.' },
        project: { ...PROJECT, description: 'Limit to one project (optional).' },
        include_transcripts: { type: 'boolean', description: 'Also search raw Claude Code transcripts (long and noisy; default false).' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Default 8.' },
      },
    },
    async run(d, a) {
      const q = String(a.query ?? '').trim();
      if (!q) throw new WriteError('query is required');
      const project = a.project ? await resolveSlug(d, a.project) : null;
      const r = await search(d, { q, project, kinds: a.include_transcripts === true ? ['all'] : [], k: Number(a.limit) || 8 });
      if (!r.results.length) return `Nothing found for "${q}"${project ? ` in ${project}` : ''}.`;
      return cap([`Search "${q}" (semantic ${r.semantic}):`, ...r.results.map((h, i) =>
        `${i + 1}. ${h.path}${h.heading ? ` › ${h.heading}` : ''} (${h.kind}${h.doc_date ? `, ${h.doc_date}` : ''})\n${h.text.trim()}`)].join('\n\n'));
    },
  },
  {
    name: 'brain_get_document', title: 'Read a vault file', scope: 'brain:read', annotations: READ,
    description: 'Read one vault file by path, e.g. "projects/hq-brain/memory.md" or "profile/profile.md".',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'Vault-relative path of a .md file.' } } },
    async run(d, a) {
      const p = String(a.path ?? '').trim().replace(/^\/+/, '');
      if (!p || p.length > 400) throw new WriteError('path is required');
      const doc = await d.store.rpc<null | { path: string; body: string; doc_date: string | null }>('brain_get_document', { p_path: p });
      if (!doc) throw new WriteError(`${p} is not in the brain (not indexed, blocked as a secret, or it does not exist).`);
      return cap(`# ${doc.path}\n\n${doc.body}`);
    },
  },
  {
    name: 'brain_recent_activity', title: 'Recent activity', scope: 'brain:read', annotations: READ,
    description: 'What changed in the brain lately, and who changed it (PC syncs, connector saves, agents).',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 25.' } } },
    async run(d, a) {
      const n = Math.max(1, Math.min(100, Number(a.limit) || 25));
      const ev = (await d.store.rpc<Array<{ ts: string; actor: string; action: string; project_slug: string | null; path: string | null; summary: string }>>('brain_recent_events', { p_limit: n * 3 })) ?? [];
      // Tool-call audit rows are noise here; show what changed.
      const rows = ev.filter((e) => e.action !== 'tool_call').slice(0, n);
      if (!rows.length) return 'No activity yet.';
      return rows.map((e) => `- ${e.ts.slice(0, 16).replace('T', ' ')} UTC · ${e.actor} · ${e.action}${e.project_slug ? ` · ${e.project_slug}` : ''}${e.path ? ` · ${e.path}` : ''}${e.summary ? ` · ${e.summary}` : ''}`).join('\n');
    },
  },
  {
    name: 'brain_get_setup_kit', title: 'New device setup kit', scope: 'brain:read', annotations: READ,
    description: 'Everything needed to set up a new computer or Claude account: the setup guide, the memory-vault skill, the /load /save /new-project /projects /recall command files, and the scheduled-task prompts.',
    inputSchema: { type: 'object', properties: {} },
    async run(d) {
      const part = (title: string, rel: string) => { const t = readVaultFile(d, rel); return t ? `## ${title} (${rel})\n\n${t.trim()}` : null; };
      const listDir = (rel: string) => { try { return fs.readdirSync(path.join(d.vaultDir, rel)).filter((f) => f.endsWith('.md')).sort(); } catch { return []; } };
      const out = [
        '# HQ Brain setup kit',
        'Connector: Claude › Settings › Connectors › Add custom connector › URL `https://hq.rizehub.ph/mcp/brain`, then sign in to HQ (2FA).',
        part('New computer setup', 'docs/new-computer-setup.md'),
        part('Skill: memory-vault', 'skills/memory-vault/SKILL.md'),
        ...listDir('claude-commands').map((f) => part(`Command /${f.replace(/\.md$/, '')}`, `claude-commands/${f}`)),
        ...listDir('scheduled-tasks').map((f) => part(`Scheduled task ${f}`, `scheduled-tasks/${f}`)),
      ].filter(Boolean);
      return cap(out.join('\n\n'));
    },
  },
  {
    name: 'brain_save_session', title: 'Save this session', scope: 'brain:write', annotations: WRITE,
    description: "Save this chat's progress to a project (= /save): writes a dated session summary, adds it to the project's session log, and updates memory.md (new decisions, the current next steps). Keep it factual and short. Never include secrets (API keys, passwords, tokens): write where they are stored instead.",
    inputSchema: {
      type: 'object', required: ['project', 'title'],
      properties: {
        project: PROJECT,
        title: { type: 'string', description: 'Short title of what the session did.' },
        source: { type: 'string', enum: ['web', 'desktop', 'mobile', 'claude-code', 'agent'], description: 'Where this chat runs (default web).' },
        goal: str,
        what_we_did: lines('What was done, one line each.'),
        decisions: lines('Decisions made, one line each (added to the Decisions log with today\'s date).'),
        files: lines('Files, URLs, repos touched.'),
        next_steps: lines("The project's CURRENT open next steps (replaces the list in memory.md; leave out what is done). Omit to keep the list as it is."),
        status: lines('Optional: new Status bullets (replaces the Status section).'),
        facts: { type: 'array', description: 'Optional durable facts: bullets added to a memory.md section.', items: { type: 'object', required: ['section', 'lines'], properties: { section: { type: 'string', description: 'e.g. Links, Contacts, Overview' }, lines: lines('Bullets to add.') } } },
      },
    },
    async run(d, a, caller) {
      const r = await d.service.write(saveSessionOp(a as unknown as SessionInput), actorOf(caller));
      return `Saved to ${r.project}: ${r.detail?.file ?? r.paths[0]} (commit ${r.sha.slice(0, 7)}). Files: ${r.paths.join(', ')}.`;
    },
  },
  {
    name: 'brain_update_memory', title: 'Update project memory', scope: 'brain:write', annotations: WRITE,
    description: "Edit a project's memory.md without a session summary: add decisions, replace the open next steps or the status, or add facts to a section. Never include secrets.",
    inputSchema: {
      type: 'object', required: ['project'],
      properties: {
        project: PROJECT,
        decisions: lines('New decisions (dated today unless they start with YYYY-MM-DD:).'),
        next_steps: lines('Replaces "Open next steps" with this list.'),
        status: lines('Replaces "Status" with these bullets.'),
        facts: { type: 'array', items: { type: 'object', required: ['section', 'lines'], properties: { section: str, lines: lines('Bullets to add.') } } },
      },
    },
    async run(d, a, caller) {
      const r = await d.service.write(updateMemoryOp(String(a.project ?? ''), a), actorOf(caller));
      return `Updated ${r.paths[0]}: ${r.summary.replace(/^memory: /, '')} (commit ${r.sha.slice(0, 7)}).`;
    },
  },
  {
    name: 'brain_create_project', title: 'Create a project', scope: 'brain:write', annotations: WRITE,
    description: 'Create a new project in the vault (= /new-project): projects.json entry, memory.md from the template, and an empty session log. Refuses when the name or an alias already matches a project.',
    inputSchema: {
      type: 'object', required: ['name'],
      properties: {
        name: { type: 'string', description: 'Project name, e.g. "Spicy Voyage Shopify".' },
        slug: { type: 'string', description: 'Optional; default = the name lowercased with "-".' },
        aliases: lines('Lowercase keywords that should find it: brand, domain, client name. Avoid generic words like "website".'),
        description: str, client: str, platform: str,
        links: lines('Links bullets, e.g. "Site: https://…", "Repo: github.com/…".'),
      },
    },
    async run(d, a, caller) {
      const r = await d.service.write(createProjectOp(a as unknown as NewProject), actorOf(caller));
      return `Created ${r.detail?.slug ?? r.project} (commit ${r.sha.slice(0, 7)}). It is the active project now: brain_save_session writes there.`;
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
const textResult = (text: string, isError = false) => ({ content: [{ type: 'text', text }], isError });

function visible(caller: Caller) {
  return TOOLS.filter((t) => caller.scopes.includes(t.scope));
}

async function callTool(d: McpDeps, caller: Caller, params: unknown) {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof p.name !== 'string') throw new RpcError(-32602, 'tools/call needs params.name');
  const tool = byName.get(p.name);
  if (!tool) throw new RpcError(-32602, `Unknown tool "${p.name}"`);
  if (!caller.scopes.includes(tool.scope)) return textResult(`${tool.name} needs the ${tool.scope} permission, which this connection was not given. Reconnect the Brain connector and allow saving.`, true);
  const args = (p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? p.arguments : {}) as Record<string, unknown>;
  const started = Date.now();
  let ok = false;
  try {
    const text = await tool.run(d, args, caller);
    ok = true;
    return textResult(text);
  } catch (e) {
    const msg = (e as Error).message;
    if (!(e instanceof WriteError)) d.log(`mcp ${tool.name} failed: ${msg}`);
    return textResult(e instanceof WriteError ? msg : `Error: ${msg.slice(0, 500)}`, true);
  } finally {
    await d.store.rpc('brain_log_event', {
      p_actor: actorOf(caller), p_action: 'tool_call', p_project: null, p_path: null, p_summary: tool.name,
      p_meta: { tool: tool.name, ok, ms: Date.now() - started, client_id: caller.clientId },
    }).catch(() => {});
  }
}

async function handleOne(d: McpDeps, caller: Caller, msg: RpcRequest): Promise<RpcResponse | null> {
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
          instructions: "Julev's long-term project memory (the HQ Brain). /load or \"load <project>\" → brain_load_project; /save → brain_save_session; "
            + '/new-project → brain_create_project; /projects → brain_list_projects; /recall → brain_search. '
            + 'Never write secrets (keys, passwords, tokens) into the brain: note where they are stored instead.',
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list':
        result = { tools: visible(caller).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } })) };
        break;
      case 'tools/call': result = await callTool(d, caller, msg.params); break;
      case 'resources/list': result = { resources: [] }; break;
      case 'prompts/list': result = { prompts: [] }; break;
      default:
        if (msg.method.startsWith('notifications/')) return null;
        throw new RpcError(-32601, `Method not found: ${msg.method}`);
    }
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  } catch (e) {
    if (isNotification) return null;
    const code = e instanceof RpcError ? e.code : -32603;
    return { jsonrpc: '2.0', id, error: { code, message: e instanceof RpcError ? e.message : `Internal error: ${(e as Error).message.slice(0, 300)}` } };
  }
}

export interface McpReply { status: number; body?: unknown; unauthorized?: boolean }

/** POST /mcp. `authorization` = the caller's Authorization header, passed through by the dashboard. */
export async function handleMcpPost(d: McpDeps, authorization: string | undefined, raw: Buffer): Promise<McpReply> {
  const caller = await authenticate(d.store, authorization);
  if (!caller) return { status: 401, unauthorized: true, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized: connect the Brain connector (OAuth)' } } };
  if (raw.length > MCP_MAX_BODY) return { status: 413, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'body too large' } } };
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } }; }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as RpcRequest[];
  if (!msgs.length || msgs.length > 20) return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  const out: RpcResponse[] = [];
  for (const m of msgs) {
    const r = await handleOne(d, caller, m && typeof m === 'object' ? m : {});
    if (r) out.push(r);
  }
  if (!out.length) return { status: 202 };
  return { status: 200, body: batch ? out : out[0] };
}
