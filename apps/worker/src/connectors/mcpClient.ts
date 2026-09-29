// MCP client for connected apps (docs/15 §4). Streamable HTTP (SSE only as a fallback), auth by OAuth (MCP authorization:
// discovery → CIMD client id `…/oauth/client-metadata.json` → dynamic registration → PKCE, via the official SDK) or by a
// pasted token header. Tokens live only inside the sealed connector secret; refreshed tokens are saved back through onSave.
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { MCP_CALLBACK_PATH, MCP_CLIENT_METADATA_PATH, type McpToolLike } from '@rizehubhq/shared';

export type OAuthSecret = { kind: 'oauth'; tokens?: OAuthTokens; client?: OAuthClientInformationMixed; own?: boolean };
export type HeaderSecret = { kind: 'header'; header: string; value: string };
export type McpSecret = OAuthSecret | HeaderSecret;

export interface McpToolDef extends McpToolLike { inputSchema: Record<string, unknown> }
export interface McpCallResult { text: string; isError: boolean }
export interface McpSession {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}
export type McpOpener = (url: string, secret: McpSecret, onSave?: (s: McpSecret) => Promise<void>) => Promise<McpSession>;

/** The stored sign-in no longer works (expired / revoked): the CEO has to reconnect. */
export class McpNeedsSignIn extends Error {}

const MAX_RESULT = 8000;

class HqOAuthProvider implements OAuthClientProvider {
  clientMetadataUrl?: string;
  private verifier = '';
  constructor(private o: {
    publicUrl: string; secret: OAuthSecret; state?: string; interactive: boolean;
    onRedirect?: (url: URL) => void; onSave?: (s: OAuthSecret) => Promise<void>;
  }) {
    // Own OAuth apps (HubSpot, Meta, Dropbox) are pre-registered; everyone else identifies HQ by its metadata document.
    if (!o.secret.own) this.clientMetadataUrl = `${o.publicUrl}${MCP_CLIENT_METADATA_PATH}`;
  }
  get redirectUrl() { return `${this.o.publicUrl}${MCP_CALLBACK_PATH}`; }
  get clientMetadata(): OAuthClientMetadata {
    const hasSecret = Boolean((this.o.secret.client as { client_secret?: string } | undefined)?.client_secret);
    return {
      client_name: 'RizeHub HQ', client_uri: this.o.publicUrl, redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: hasSecret ? 'client_secret_post' : 'none',
    };
  }
  state() { return this.o.state ?? ''; }
  clientInformation() { return this.o.secret.client; }
  async saveClientInformation(ci: OAuthClientInformationMixed) { this.o.secret.client = ci; }
  tokens() { return this.o.secret.tokens; }
  async saveTokens(t: OAuthTokens) { this.o.secret.tokens = t; await this.o.onSave?.(this.o.secret); }
  redirectToAuthorization(url: URL) {
    if (!this.o.interactive) throw new McpNeedsSignIn('The sign-in expired. Reconnect this app in Admin → Connectors.');
    this.o.onRedirect?.(url);
  }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

function resultText(r: { content?: unknown; structuredContent?: unknown; isError?: unknown }): McpCallResult {
  const parts: string[] = [];
  for (const c of (Array.isArray(r.content) ? r.content : []) as Record<string, unknown>[]) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'image' || c.type === 'audio') parts.push(`[${c.type} ${String(c.mimeType ?? '')} returned; binary not shown]`);
    else if (c.type === 'resource_link' || c.type === 'resource') {
      const res = (c.resource ?? c) as Record<string, unknown>;
      parts.push(`[resource ${String(res.uri ?? res.name ?? '')}]${typeof res.text === 'string' ? `\n${res.text}` : ''}`);
    }
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  const text = parts.join('\n').trim() || '(no content)';
  return { text: text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n…[truncated]` : text, isError: r.isError === true };
}

/** Whether an error means the stored sign-in/token is no longer accepted. */
export function isAuthFailure(e: unknown): boolean {
  if (e instanceof McpNeedsSignIn || e instanceof UnauthorizedError) return true;
  const m = e instanceof Error ? e.message : String(e);
  return /\b(401|403)\b|unauthori[sz]ed|invalid[_ ]token|forbidden/i.test(m);
}

export function createMcpOpener(publicUrl: string): McpOpener {
  return async (url, secret, onSave) => {
    const makeTransport = (sse: boolean) => {
      const opts = secret.kind === 'oauth'
        ? { authProvider: new HqOAuthProvider({ publicUrl, secret, interactive: false, onSave: onSave as (s: OAuthSecret) => Promise<void> }) }
        : { requestInit: { headers: { [secret.header]: secret.value } } };
      return sse ? new SSEClientTransport(new URL(url), opts) : new StreamableHTTPClientTransport(new URL(url), opts);
    };
    let client = new Client({ name: 'rizehub-hq', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(makeTransport(false), { timeout: 30_000 });
    } catch (e) {
      if (isAuthFailure(e)) throw e;
      // Older servers only speak SSE.
      client = new Client({ name: 'rizehub-hq', version: '1.0.0' }, { capabilities: {} });
      await client.connect(makeTransport(true), { timeout: 30_000 });
    }
    return {
      async listTools() {
        const out: McpToolDef[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const r = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
          for (const t of r.tools) {
            out.push({ name: t.name, description: t.description ?? '', inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
              annotations: (t.annotations ?? null) as McpToolDef['annotations'] });
          }
          cursor = r.nextCursor;
          if (!cursor) break;
        }
        return out;
      },
      async callTool(name, args) {
        return resultText(await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }) as Record<string, unknown>);
      },
      close: async () => { await client.close().catch(() => undefined); },
    };
  };
}

// ---------- interactive sign-in (the CEO's browser does the consent step) ----------
interface Pending { provider: HqOAuthProvider; secret: OAuthSecret; url: string; meta: Record<string, unknown>; at: number }
const pending = new Map<string, Pending>();
const PENDING_TTL_MS = 15 * 60_000;

/**
 * Starts sign-in: discovers the server's authorization server, identifies HQ (own app / CIMD / dynamic registration) and
 * returns the consent URL. `meta` rides along until finishSignIn (name, catalog key, agents).
 */
export async function startSignIn(o: { url: string; publicUrl: string; own?: { clientId: string; clientSecret?: string }; meta: Record<string, unknown> }):
  Promise<{ state: string; authorizeUrl: string } | { state: string; authorizeUrl: null }> {
  for (const [k, v] of pending) if (Date.now() - v.at > PENDING_TTL_MS) pending.delete(k);
  const state = randomBytes(24).toString('base64url');
  const secret: OAuthSecret = { kind: 'oauth', own: Boolean(o.own),
    ...(o.own ? { client: { client_id: o.own.clientId, ...(o.own.clientSecret ? { client_secret: o.own.clientSecret } : {}) } } : {}) };
  let authorizeUrl: string | null = null;
  const provider = new HqOAuthProvider({ publicUrl: o.publicUrl, secret, state, interactive: true, onRedirect: (u) => { authorizeUrl = u.toString(); } });
  await auth(provider, { serverUrl: o.url });
  pending.set(state, { provider, secret, url: o.url, meta: o.meta, at: Date.now() });
  return { state, authorizeUrl };
}

/** Finishes sign-in with the code from the redirect. Returns the secret (tokens + client) and what started it. */
export async function finishSignIn(state: string, code: string): Promise<{ secret: OAuthSecret; url: string; meta: Record<string, unknown> }> {
  const p = pending.get(state);
  if (!p || Date.now() - p.at > PENDING_TTL_MS) throw new Error('This sign-in expired or was already used. Start again from Admin → Connectors.');
  pending.delete(state);
  await auth(p.provider, { serverUrl: p.url, authorizationCode: code });
  if (!p.secret.tokens?.access_token) throw new Error('The app did not return an access token.');
  return { secret: p.secret, url: p.url, meta: p.meta };
}

/** A sign-in that needed no consent (server has no auth) still returns a secret. */
export function takePending(state: string) {
  const p = pending.get(state);
  pending.delete(state);
  return p ? { secret: p.secret, url: p.url, meta: p.meta } : null;
}
