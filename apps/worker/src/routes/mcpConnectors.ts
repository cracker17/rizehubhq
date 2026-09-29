// Admin → Connectors → Apps (MCP), docs/15 §2–4. The dashboard (CEO + 2FA checked there) starts a sign-in, finishes it
// with the code from the redirect, or connects with a pasted token; the worker lists the server's tools, applies the
// default permissions (packages/shared defaultToolPolicy) and stores the connection with its tokens sealed.
// Tokens and client secrets are never logged or returned.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { catalogEntry, defaultToolPolicy, type CatalogEntry } from '@rizehubhq/shared';
import type { Route } from './types';
import { workerEnv } from '../config';
import { createServiceClient } from '../db';
import { loadKeyring, open, seal, type Keyring } from '../vault/crypto';
import { connectorContext, createSupabaseConnectorStore, type ConnectorStore, type SyncedTool } from '../connectors/store';
import {
  createMcpOpener, finishSignIn, isAuthFailure, startSignIn, takePending, type McpOpener, type McpSecret, type McpToolDef, type OAuthSecret,
} from '../connectors/mcpClient';
import { assertPublicUrl, defaultNetEnv } from '../research/net';

const AGENT = z.string().regex(/^[a-z0-9-]{1,64}$/);
const Target = z.object({
  catalogKey: z.string().max(40).optional(),
  url: z.string().max(500).optional(),
  name: z.string().max(120).optional(),
  agents: z.array(AGENT).max(10).default([]),
  projectRef: z.string().regex(/^[a-z]{20}$/).optional(),
});
const Start = Target.extend({ own: z.object({ clientId: z.string().min(1).max(300), clientSecret: z.string().max(500).optional() }).optional() });
const Token = Target.extend({ token: z.string().min(8).max(4000), header: z.string().regex(/^[A-Za-z0-9-]{1,60}$/).optional(), prefix: z.string().max(30).optional() });
const Finish = z.object({ state: z.string().min(20).max(100), code: z.string().min(1).max(4000) });
const Sync = z.object({ id: z.string().uuid() });

export interface McpRouteDeps {
  store: () => ConnectorStore;
  keyring: () => Keyring | null;
  publicUrl: () => string;
  open?: McpOpener;
  /** SSRF guard for custom URLs (tests pass a stub). */
  checkUrl?: (url: string) => Promise<void>;
  start?: typeof startSignIn;
  finish?: typeof finishSignIn;
}

function parse<S extends z.ZodTypeAny>(schema: S, raw: Buffer): z.output<S> | string {
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return 'invalid JSON'; }
  const r = schema.safeParse(body);
  return r.success ? (r.data as z.output<S>) : (r.error.issues[0]?.message ?? 'invalid input');
}

/** Tools as stored, with the default permission for this catalog entry (custom servers: no entry). */
export function toSynced(tools: McpToolDef[], entry: CatalogEntry | null): SyncedTool[] {
  return tools.map((t) => {
    const d = defaultToolPolicy(t, entry);
    return {
      name: t.name, description: (t.description ?? '').slice(0, 4000), input_schema: t.inputSchema,
      annotations: (t.annotations ?? {}) as Record<string, unknown>, policy: d.policy, locked: d.locked, badges: d.badges,
    };
  });
}

const friendly = (e: unknown) => {
  if (isAuthFailure(e)) return 'The app refused the sign-in or token. Check it and try again.';
  const m = e instanceof Error ? e.message : String(e);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed out|timeout/i.test(m)) return 'Could not reach the app’s MCP server. Try again in a minute.';
  if (/invalid_client|unauthorized_client|client/i.test(m) && /regist|client_id|metadata/i.test(m)) return `The app didn't accept HQ as a client: ${m.slice(0, 200)}`;
  return m.slice(0, 300);
};

export function createMcpConnectorRoutes(d: McpRouteDeps): Route[] {
  const opener = () => d.open ?? createMcpOpener(d.publicUrl());
  const noKey: [number, unknown] = [503, { error: 'The worker cannot encrypt secrets: VAULT_MASTER_KEY is not set.' }];

  async function target(b: z.output<typeof Target>): Promise<{ entry: CatalogEntry | null; url: string; name: string } | string> {
    const entry = catalogEntry(b.catalogKey);
    if (b.catalogKey && !entry) return 'Unknown app.';
    let url = entry?.url ?? b.url ?? '';
    if (!entry) {
      if (!/^https:\/\//i.test(url)) return 'Use the server’s https:// URL.';
      try { await (d.checkUrl ?? (async (u) => { await assertPublicUrl(u, defaultNetEnv()); }))(url); } catch { return 'That URL points to a private or blocked address.'; }
    }
    if (entry?.urlParam && b.projectRef) {
      const u = new URL(url);
      u.searchParams.set(entry.urlParam.name, b.projectRef);
      url = u.toString();
    }
    const name = b.name?.trim() || entry?.name || new URL(url).hostname;
    return { entry, url, name };
  }

  /** Connects with the new secret, lists the tools and stores everything. Nothing is saved if listing fails. */
  async function saveNew(secret: McpSecret, t: { entry: CatalogEntry | null; url: string; name: string }, agents: string[], kr: Keyring): Promise<{ id: string; tools: number }> {
    const session = await opener()(t.url, secret);
    let tools: McpToolDef[];
    try { tools = await session.listTools(); } finally { await session.close(); }
    const id = randomUUID();
    await d.store().insert({
      id, kind: 'mcp', name: t.name, accountEmail: null, url: t.url,
      authType: secret.kind === 'oauth' ? 'oauth' : secret.header.toLowerCase() === 'authorization' ? 'bearer' : 'header',
      settings: { catalog: t.entry?.key ?? null }, sealed: seal(JSON.stringify(secret), kr, connectorContext(id)), grants: agents, catalogKey: t.entry?.key ?? null,
    });
    await d.store().syncTools!(id, toSynced(tools, t.entry), true);
    return { id, tools: tools.length };
  }

  return [
    {
      method: 'POST', path: '/connectors/mcp/start', auth: 'secret',
      handle: async (_req, raw) => {
        const b = parse(Start, raw);
        if (typeof b === 'string') return [400, { error: b }];
        const kr = d.keyring();
        if (!kr) return noKey;
        const t = await target(b);
        if (typeof t === 'string') return [400, { error: t }];
        if (t.entry?.auth.includes('own_app') && !b.own) return [400, { error: `${t.entry.name} needs your own OAuth app: enter its client ID and secret.` }];
        try {
          const s = await (d.start ?? startSignIn)({ url: t.url, publicUrl: d.publicUrl(), own: b.own, meta: { catalogKey: t.entry?.key ?? null, name: t.name, url: t.url, agents: b.agents } });
          if (s.authorizeUrl) return [200, { authorizeUrl: s.authorizeUrl }];
          const p = takePending(s.state);
          if (!p) return [500, { error: 'Sign-in state was lost. Try again.' }];
          return [200, await saveNew(p.secret, t, b.agents, kr)];
        } catch (e) {
          return [400, { error: friendly(e) }];
        }
      },
    },
    {
      method: 'POST', path: '/connectors/mcp/finish', auth: 'secret',
      handle: async (_req, raw) => {
        const b = parse(Finish, raw);
        if (typeof b === 'string') return [400, { error: b }];
        const kr = d.keyring();
        if (!kr) return noKey;
        try {
          const r = await (d.finish ?? finishSignIn)(b.state, b.code);
          const meta = r.meta as { catalogKey: string | null; name: string; agents: string[] };
          const saved = await saveNew(r.secret as OAuthSecret, { entry: catalogEntry(meta.catalogKey), url: r.url, name: meta.name }, meta.agents ?? [], kr);
          return [200, { ...saved, name: meta.name }];
        } catch (e) {
          return [400, { error: friendly(e) }];
        }
      },
    },
    {
      method: 'POST', path: '/connectors/mcp/token', auth: 'secret',
      handle: async (_req, raw) => {
        const b = parse(Token, raw);
        if (typeof b === 'string') return [400, { error: b }];
        const kr = d.keyring();
        if (!kr) return noKey;
        const t = await target(b);
        if (typeof t === 'string') return [400, { error: t }];
        const header = b.header ?? t.entry?.tokenHeader?.name ?? 'Authorization';
        const prefix = b.prefix ?? t.entry?.tokenHeader?.prefix ?? (header.toLowerCase() === 'authorization' ? 'Bearer ' : '');
        const token = b.token.trim();
        const value = prefix && !token.toLowerCase().startsWith(prefix.trim().toLowerCase()) ? `${prefix}${token}` : token;
        try {
          return [200, await saveNew({ kind: 'header', header, value }, t, b.agents, kr)];
        } catch (e) {
          return [400, { error: friendly(e) }];
        }
      },
    },
    {
      method: 'POST', path: '/connectors/mcp/sync', auth: 'secret',
      handle: async (_req, raw) => {
        const b = parse(Sync, raw);
        if (typeof b === 'string') return [400, { error: b }];
        const kr = d.keyring();
        if (!kr) return noKey;
        const c = await d.store().get(b.id);
        if (!c || c.kind !== 'mcp' || !c.url || !c.sealed) return [404, { error: 'Unknown app connection.' }];
        let secret: McpSecret;
        try { secret = JSON.parse(open(c.sealed, kr, connectorContext(c.id))) as McpSecret; } catch { return [200, { ok: false, error: 'The stored sign-in could not be decrypted. Reconnect the app.' }]; }
        const onSave = async (s: McpSecret) => { await d.store().rotate(c.id, seal(JSON.stringify(s), kr, connectorContext(c.id))); };
        try {
          const session = await opener()(c.url, secret, onSave);
          let tools: McpToolDef[];
          try { tools = await session.listTools(); } finally { await session.close(); }
          await d.store().syncTools!(c.id, toSynced(tools, catalogEntry((c.settings as { catalog?: string }).catalog)), false);
          await d.store().mark(c.id, 'active', null, false);
          return [200, { ok: true, tools: tools.length }];
        } catch (e) {
          await d.store().mark(c.id, isAuthFailure(e) ? 'needs_reauth' : 'error', friendly(e)).catch(() => undefined);
          return [200, { ok: false, error: friendly(e) }];
        }
      },
    },
  ];
}

let store: ConnectorStore | null = null;
export const mcpConnectorRoutes: Route[] = createMcpConnectorRoutes({
  store: () => (store ??= createSupabaseConnectorStore(createServiceClient())),
  keyring: () => loadKeyring(workerEnv()),
  publicUrl: () => (workerEnv().DASHBOARD_URL ?? 'https://hq.rizehub.ph').replace(/\/+$/, ''),
});
