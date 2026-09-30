// OAuth 2.1 authorization server for the Brain connector (docs/16-BRAIN.md "Connector"). Lives in the brain service
// because it holds the service-role key; the dashboard is the public door and proxies these calls:
//   POST /oauth/register   RFC 7591 dynamic client registration (public; redirect URIs must pass the allowlist)
//   GET  /oauth/client     client + redirect check for the consent page (dashboard only)
//   POST /oauth/code       the CEO approved: issue a one-time code (dashboard only, after HQ sign-in + 2FA)
//   POST /oauth/token      authorization_code (PKCE S256, required) and refresh_token (rotating) grants
//   POST /oauth/revoke     RFC 7009
// Public clients only (token_endpoint_auth_method "none"): PKCE is what binds the code to the client.
import type { Store } from '../store/types';
import {
  ACCESS_TOKEN_TTL, CODE_TTL, REFRESH_TOKEN_TTL, SCOPES, newAccessToken, newClientId, newCode, newRefreshToken, parseScopes,
  pkceOk, redirectMatches, redirectUriAllowed, sha256Hex, type Scope,
} from './crypto';

export interface OAuthDeps {
  store: Store;
  /** extra https hosts allowed as redirect URIs (BRAIN_OAUTH_REDIRECT_HOSTS) */
  redirectHosts: readonly string[];
  log: (msg: string) => void;
}

export interface Client { client_id: string; client_name: string; redirect_uris: string[]; client_uri: string | null }

type Result = [number, unknown];
const oauthError = (status: number, error: string, description: string): Result => [status, { error, error_description: description }];

// Registration is unauthenticated by design (RFC 7591); cap it per process as well as in SQL.
const registrations: number[] = [];
function registrationFlood(now = Date.now()): boolean {
  while (registrations.length && registrations[0]! < now - 60 * 60 * 1000) registrations.shift();
  if (registrations.length >= 30) return true;
  registrations.push(now);
  return false;
}

export async function register(d: OAuthDeps, body: Record<string, unknown>): Promise<Result> {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10) return oauthError(400, 'invalid_redirect_uri', 'redirect_uris must list 1 to 10 URIs');
  const bad = uris.find((u) => !redirectUriAllowed(u, d.redirectHosts));
  if (bad !== undefined) return oauthError(400, 'invalid_redirect_uri', `redirect URI not allowed: ${String(bad).slice(0, 200)}`);
  const method = body.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') return oauthError(400, 'invalid_client_metadata', 'only public clients (token_endpoint_auth_method "none") are supported');
  const grants = (body.grant_types ?? ['authorization_code']) as unknown;
  if (!Array.isArray(grants) || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    return oauthError(400, 'invalid_client_metadata', 'grant_types may only be authorization_code and refresh_token');
  }
  if (registrationFlood()) return oauthError(429, 'temporarily_unavailable', 'too many registrations, try again later');
  const name = typeof body.client_name === 'string' ? body.client_name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100) : '';
  const clientUri = typeof body.client_uri === 'string' && /^https:\/\//.test(body.client_uri) ? body.client_uri.slice(0, 300) : null;
  let client: Client;
  try {
    client = await d.store.rpc<Client>('brain_oauth_register', {
      p: { client_id: newClientId(), client_name: name || 'MCP client', redirect_uris: uris, client_uri: clientUri, meta: { software_id: String(body.software_id ?? '').slice(0, 100) } },
    });
  } catch (e) {
    if (/too many registered clients/.test((e as Error).message)) return oauthError(429, 'temporarily_unavailable', 'too many registered clients');
    throw e;
  }
  d.log(`oauth: registered client "${client.client_name}" (${client.client_id})`);
  return [201, {
    client_id: client.client_id, client_name: client.client_name, redirect_uris: client.redirect_uris, client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPES.join(' '),
  }];
}

export async function getClient(d: OAuthDeps, clientId: string | null): Promise<Client | null> {
  if (!clientId || !/^hqbc_[A-Za-z0-9_-]{16,64}$/.test(clientId)) return null;
  return d.store.rpc<Client | null>('brain_oauth_client', { p_client_id: clientId });
}

/** Consent page check: the client exists and the redirect URI is one it registered. Never redirect when this fails. */
export async function clientCheck(d: OAuthDeps, clientId: string | null, redirectUri: string | null): Promise<Result> {
  const client = await getClient(d, clientId);
  if (!client) return [404, { error: 'unknown client' }];
  if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri)) return [400, { error: 'redirect_uri does not match the registered client' }];
  return [200, { client_id: client.client_id, client_name: client.client_name, client_uri: client.client_uri, redirect_uri: redirectUri, scopes: SCOPES }];
}

/** The CEO approved (the dashboard checked the HQ session, CEO row and 2FA). Body: {client_id, redirect_uri, code_challenge, code_challenge_method, scopes[], resource, user_id}. */
export async function issueCode(d: OAuthDeps, b: Record<string, unknown>): Promise<Result> {
  const client = await getClient(d, typeof b.client_id === 'string' ? b.client_id : null);
  if (!client) return [404, { error: 'unknown client' }];
  const redirectUri = String(b.redirect_uri ?? '');
  if (!redirectMatches(client.redirect_uris, redirectUri)) return [400, { error: 'redirect_uri does not match' }];
  if (b.code_challenge_method !== 'S256' || typeof b.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(b.code_challenge)) {
    return [400, { error: 'PKCE S256 code_challenge is required' }];
  }
  if (typeof b.user_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.user_id)) return [400, { error: 'user_id is required' }];
  const scopes = (Array.isArray(b.scopes) ? b.scopes : []).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s as string));
  if (!scopes.includes('brain:read')) return [400, { error: 'brain:read is required' }];
  const code = newCode();
  try {
    await d.store.rpc('brain_oauth_issue_code', {
      p: {
        code_hash: sha256Hex(code), client_id: client.client_id, user_id: b.user_id, redirect_uri: redirectUri, code_challenge: b.code_challenge,
        scopes, resource: typeof b.resource === 'string' ? b.resource.slice(0, 300) : null, ttl_seconds: CODE_TTL,
      },
    });
  } catch (e) {
    if (/not the CEO/.test((e as Error).message)) return [403, { error: 'only the CEO can approve the Brain connector' }];
    throw e;
  }
  await d.store.rpc('brain_log_event', {
    p_actor: 'julev', p_action: 'connected', p_project: null, p_path: null,
    p_summary: `approved ${client.client_name} (${scopes.join(', ')})`, p_meta: { client_id: client.client_id },
  });
  return [200, { code }];
}

interface IssueFor { family_id: string; client_id: string; user_id: string | null; subject: string; scopes: string[]; resource: string | null }

async function issuePair(d: OAuthDeps, f: IssueFor): Promise<Result> {
  const access = newAccessToken();
  const refresh = newRefreshToken();
  await d.store.rpc('brain_token_issue', {
    p: {
      family_id: f.family_id, client_id: f.client_id, user_id: f.user_id, subject: f.subject, scopes: f.scopes, resource: f.resource,
      access: { hash: sha256Hex(access), ttl_seconds: ACCESS_TOKEN_TTL }, refresh: { hash: sha256Hex(refresh), ttl_seconds: REFRESH_TOKEN_TTL },
    },
  });
  return [200, { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL, refresh_token: refresh, scope: f.scopes.join(' ') }];
}

/** Token endpoint. `b` = the form fields (application/x-www-form-urlencoded, or JSON). */
export async function token(d: OAuthDeps, b: Record<string, unknown>): Promise<Result> {
  const clientId = typeof b.client_id === 'string' ? b.client_id : null;
  const client = await getClient(d, clientId);
  if (!client) return oauthError(401, 'invalid_client', 'unknown client_id');
  if (b.grant_type === 'authorization_code') {
    if (typeof b.code !== 'string' || b.code.length > 200) return oauthError(400, 'invalid_request', 'code is required');
    const row = await d.store.rpc<null | { redirect_uri: string; code_challenge: string; user_id: string; scopes: string[]; resource: string | null; family_id: string }>(
      'brain_oauth_redeem_code', { p_code_hash: sha256Hex(b.code), p_client_id: client.client_id });
    if (!row) return oauthError(400, 'invalid_grant', 'the code is invalid, expired or already used');
    if (b.redirect_uri !== undefined && b.redirect_uri !== row.redirect_uri) return oauthError(400, 'invalid_grant', 'redirect_uri does not match');
    if (!pkceOk(b.code_verifier, row.code_challenge)) return oauthError(400, 'invalid_grant', 'PKCE verification failed');
    if (typeof b.resource === 'string' && row.resource && b.resource !== row.resource) return oauthError(400, 'invalid_target', 'resource does not match the approval');
    d.log(`oauth: tokens issued to "${client.client_name}"`);
    return issuePair(d, { family_id: row.family_id, client_id: client.client_id, user_id: row.user_id, subject: 'ceo', scopes: row.scopes, resource: row.resource });
  }
  if (b.grant_type === 'refresh_token') {
    if (typeof b.refresh_token !== 'string' || b.refresh_token.length > 200) return oauthError(400, 'invalid_request', 'refresh_token is required');
    const row = await d.store.rpc<null | IssueFor>('brain_token_refresh', { p_hash: sha256Hex(b.refresh_token), p_client_id: client.client_id });
    if (!row) return oauthError(400, 'invalid_grant', 'the refresh token is invalid, expired or revoked');
    // A narrower scope may be asked for on refresh, never a wider one.
    const asked = b.scope === undefined ? row.scopes : (parseScopes(b.scope) ?? []).filter((s) => row.scopes.includes(s));
    if (!asked.length) return oauthError(400, 'invalid_scope', 'scope exceeds the approval');
    return issuePair(d, { ...row, client_id: client.client_id, scopes: asked });
  }
  return oauthError(400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
}

export async function revoke(d: OAuthDeps, b: Record<string, unknown>): Promise<Result> {
  if (typeof b.token === 'string' && b.token.length <= 200) {
    const n = await d.store.rpc<number>('brain_token_revoke', { p_hash: sha256Hex(b.token), p_client_id: typeof b.client_id === 'string' ? b.client_id : null });
    if (n) d.log(`oauth: revoked ${n} token(s)`);
  }
  return [200, {}]; // RFC 7009 §2.2: unknown tokens are not an error
}

export interface Caller { tokenId: string; familyId: string; clientId: string | null; clientName: string | null; userId: string | null; subject: string; scopes: string[]; resource: string | null }

/** Authorization: Bearer <access token> → caller, or null. */
export async function authenticate(store: Store, authorization: string | undefined): Promise<Caller | null> {
  const m = /^Bearer\s+(hqb_at_[A-Za-z0-9_-]{20,100})\s*$/.exec(authorization ?? '');
  if (!m) return null;
  const r = await store.rpc<null | { token_id: string; family_id: string; client_id: string | null; client_name: string | null; user_id: string | null; subject: string; scopes: string[]; resource: string | null }>(
    'brain_token_check', { p_hash: sha256Hex(m[1]!) });
  if (!r) return null;
  return { tokenId: r.token_id, familyId: r.family_id, clientId: r.client_id, clientName: r.client_name, userId: r.user_id, subject: r.subject, scopes: r.scopes, resource: r.resource };
}
