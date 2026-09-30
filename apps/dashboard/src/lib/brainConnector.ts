import 'server-only';
import { NextResponse } from 'next/server';
import { brainEnv } from '@/lib/env';
import { publicOrigin } from '@/lib/publicUrl';

// The Brain MCP connector's public face (docs/16-BRAIN.md "Connector"). The dashboard is the only public door, so it
// serves the OAuth discovery documents itself and passes everything else to the brain service (hq-brain), which holds
// the OAuth state and runs the MCP server:
//   /.well-known/oauth-protected-resource[/mcp/brain]   RFC 9728 (points Claude at the authorization server)
//   /.well-known/oauth-authorization-server             RFC 8414
//   /oauth/register /oauth/token /oauth/revoke          → brain /oauth/*
//   /oauth/authorize                                    consent page (HQ sign-in + 2FA, CEO only)
//   /mcp/brain                                          → brain /mcp (Authorization header passed through)

export const BRAIN_MCP_PATH = '/mcp/brain';
export const BRAIN_SCOPES = ['brain:read', 'brain:write'] as const;
export const BRAIN_PROXY_MAX_BYTES = 256 * 1024;

type Req = Parameters<typeof publicOrigin>[0];

export const brainResource = (req: Req) => `${publicOrigin(req)}${BRAIN_MCP_PATH}`;
export const resourceMetadataUrl = (req: Req) => `${publicOrigin(req)}/.well-known/oauth-protected-resource${BRAIN_MCP_PATH}`;

export function protectedResourceMetadata(req: Req) {
  return {
    resource: brainResource(req),
    authorization_servers: [publicOrigin(req)],
    scopes_supported: [...BRAIN_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'HQ Brain',
    resource_documentation: 'https://hq.rizehub.ph/brain',
  };
}

export function authorizationServerMetadata(req: Req) {
  const o = publicOrigin(req);
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...BRAIN_SCOPES],
  };
}

export const metadataResponse = (body: unknown) =>
  NextResponse.json(body, { headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });

/**
 * Pass a request body to the brain service. Only the content type (and, for /mcp, the Authorization header and MCP
 * headers) go along: no cookies, no forwarded-for. The brain answers JSON (or 202 with no body).
 */
export async function proxyToBrain(request: Request, brainPath: string, opts: { passAuth?: boolean; extraHeaders?: Record<string, string> } = {}): Promise<Response> {
  const brain = brainEnv();
  if (!brain) return NextResponse.json({ error: 'temporarily_unavailable', error_description: 'The brain is not configured.' }, { status: 503 });
  if (Number(request.headers.get('content-length') ?? 0) > BRAIN_PROXY_MAX_BYTES) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > BRAIN_PROXY_MAX_BYTES) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  const headers: Record<string, string> = { 'x-brain-secret': brain.secret, ...(opts.extraHeaders ?? {}) };
  const type = request.headers.get('content-type');
  if (type && type.length <= 200) headers['content-type'] = type;
  if (opts.passAuth) {
    const auth = request.headers.get('authorization');
    if (auth && auth.length <= 300) headers.authorization = auth;
  }
  try {
    const res = await fetch(`${brain.url}${brainPath}`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(120_000), headers, body,
    });
    const text = await res.text();
    return new Response(res.status === 202 ? null : text, {
      status: res.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' },
    });
  } catch {
    return NextResponse.json({ error: 'temporarily_unavailable', error_description: 'Could not reach the brain service.' }, { status: 502 });
  }
}

/** Server-side JSON call to the brain (consent page). */
export async function brainJson<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<{ status: number; body: T & { error?: string } }> {
  const brain = brainEnv();
  if (!brain) return { status: 0, body: { error: 'The brain is not configured.' } as T & { error: string } };
  try {
    const res = await fetch(`${brain.url}${path}`, {
      method: init.method ?? 'GET', cache: 'no-store', signal: AbortSignal.timeout(15_000),
      headers: { 'x-brain-secret': brain.secret, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => ({ error: `Brain answered ${res.status}` }))) as T & { error?: string } };
  } catch {
    return { status: 0, body: { error: 'Could not reach the brain service.' } as T & { error: string } };
  }
}
