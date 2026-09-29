// OAuth for storage connections (docs/15 §6): the CEO's own Google Cloud OAuth client / Dropbox app, authorization-code
// flow with PKCE (S256) and an offline refresh token. Checked against the vendors' docs on 2026-09-29:
// - Google: developers.google.com/identity/protocols/oauth2/web-server (auth https://accounts.google.com/o/oauth2/v2/auth,
//   token https://oauth2.googleapis.com/token, access_type=offline + prompt=consent → refresh_token; PKCE parameters as in
//   developers.google.com/identity/protocols/oauth2/native-app). Scope drive.file only (non-sensitive: HQ sees only files it
//   created). Google returns a new refresh_token on refresh only sometimes: keep the old one when it doesn't.
// - Dropbox: docs.dropboxapi.com/dropbox-api/docs/oauth (auth https://www.dropbox.com/oauth2/authorize,
//   token https://api.dropboxapi.com/oauth2/token, token_access_type=offline → refresh_token; short-lived access tokens).
// Client secrets and tokens only ever live inside the sealed connector secret (or this process's memory).
import { createHash, randomBytes } from 'node:crypto';
import { STORAGE_STATE_PREFIX, type StorageProvider } from '@rizehubhq/shared';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DROPBOX_WRITE_SCOPE = 'files.content.write';

export const OAUTH_ENDPOINTS: Record<StorageProvider, { authorize: string; token: string }> = {
  drive: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' },
  dropbox: { authorize: 'https://www.dropbox.com/oauth2/authorize', token: 'https://api.dropboxapi.com/oauth2/token' },
};

/** The sealed secret of a storage connection. */
export interface StorageSecret {
  kind: 'storage';
  provider: StorageProvider;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** The saved sign-in no longer works (revoked, expired, app deleted): the CEO has to reconnect. */
export class StorageNeedsReauth extends Error {}

export type Fetch = typeof fetch;

// ---------- PKCE (RFC 7636) ----------
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url'); // 64 chars from [A-Za-z0-9_-]: within 43–128
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(p: { provider: StorageProvider; clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(OAUTH_ENDPOINTS[p.provider].authorize);
  const q = u.searchParams;
  q.set('client_id', p.clientId);
  q.set('redirect_uri', p.redirectUri);
  q.set('response_type', 'code');
  q.set('state', p.state);
  q.set('code_challenge', p.challenge);
  q.set('code_challenge_method', 'S256');
  if (p.provider === 'drive') {
    q.set('scope', DRIVE_SCOPE);
    q.set('access_type', 'offline');
    q.set('prompt', 'consent'); // always hand out a refresh token, even on a reconnect
  } else {
    // No `scope`: the token gets the scopes ticked on the app's Permissions tab (checked after the exchange).
    q.set('token_access_type', 'offline');
  }
  return u.toString();
}

interface TokenResponse { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string }

async function tokenCall(fetchFn: Fetch, provider: StorageProvider, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchFn(OAUTH_ENDPOINTS[provider].token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  let json: TokenResponse = {};
  try { json = (await res.json()) as TokenResponse; } catch { /* not JSON */ }
  if (!res.ok || json.error) {
    const code = json.error ?? `HTTP ${res.status}`;
    const why = `${code}${json.error_description ? `: ${json.error_description}` : ''}`.slice(0, 200);
    if (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client' || res.status === 401) throw new StorageNeedsReauth(why);
    throw new Error(why);
  }
  return json;
}

export interface Exchanged { secret: StorageSecret; accessToken: string; expiresAt: number }

/** Exchanges the code from the redirect (with the PKCE verifier) for tokens; insists on a refresh token and the scope. */
export async function exchangeCode(fetchFn: Fetch, p: {
  provider: StorageProvider; clientId: string; clientSecret: string; code: string; redirectUri: string; verifier: string; now?: number;
}): Promise<Exchanged> {
  const t = await tokenCall(fetchFn, p.provider, {
    grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier,
    client_id: p.clientId, client_secret: p.clientSecret,
  });
  if (!t.access_token) throw new Error('The sign-in did not return an access token.');
  if (!t.refresh_token) {
    throw new Error(p.provider === 'drive'
      ? 'Google did not return a refresh token. Remove "RizeHub HQ" at myaccount.google.com/connections and connect again.'
      : 'Dropbox did not return a refresh token. Connect again.');
  }
  const scopes = (t.scope ?? '').split(/\s+/).filter(Boolean);
  if (p.provider === 'drive' && scopes.length && !scopes.includes(DRIVE_SCOPE)) {
    throw new Error('Google Drive access was not granted. Connect again and allow HQ to "see, edit, create and delete only the specific Google Drive files you use with this app".');
  }
  if (p.provider === 'dropbox' && scopes.length && !scopes.includes(DROPBOX_WRITE_SCOPE)) {
    throw new Error('Your Dropbox app lacks the files.content.write permission. Tick it on the app\'s Permissions tab, Submit, then connect again.');
  }
  return {
    secret: { kind: 'storage', provider: p.provider, clientId: p.clientId, clientSecret: p.clientSecret, refreshToken: t.refresh_token },
    accessToken: t.access_token,
    expiresAt: (p.now ?? Date.now()) + Math.max(60, Number(t.expires_in ?? 3600)) * 1000,
  };
}

/** A fresh access token from the refresh token. `refreshToken` is set only when the vendor rotated it. */
export async function refreshAccess(fetchFn: Fetch, s: StorageSecret, now = Date.now()): Promise<{ accessToken: string; expiresAt: number; refreshToken?: string }> {
  const t = await tokenCall(fetchFn, s.provider, {
    grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: s.clientId, client_secret: s.clientSecret,
  });
  if (!t.access_token) throw new Error('The token refresh returned no access token.');
  return {
    accessToken: t.access_token,
    expiresAt: now + Math.max(60, Number(t.expires_in ?? 3600)) * 1000,
    ...(t.refresh_token && t.refresh_token !== s.refreshToken ? { refreshToken: t.refresh_token } : {}),
  };
}

// ---------- sign-ins in progress (the CEO's browser is at the consent page) ----------
export interface PendingStorage {
  provider: StorageProvider; clientId: string; clientSecret: string; name: string; appFolder: string | null;
  verifier: string; redirectUri: string; at: number;
}
const pending = new Map<string, PendingStorage>();
const PENDING_TTL_MS = 15 * 60_000;

/** Starts a sign-in: returns the consent URL. The state is prefixed so the shared callback routes it here. */
export function startStorageSignIn(p: Omit<PendingStorage, 'verifier' | 'at'>, now = Date.now()): { state: string; authorizeUrl: string } {
  for (const [k, v] of pending) if (now - v.at > PENDING_TTL_MS) pending.delete(k);
  const state = `${STORAGE_STATE_PREFIX}${randomBytes(24).toString('base64url')}`;
  const { verifier, challenge } = pkcePair();
  pending.set(state, { ...p, verifier, at: now });
  return { state, authorizeUrl: authorizeUrl({ provider: p.provider, clientId: p.clientId, redirectUri: p.redirectUri, state, challenge }) };
}

/** Takes (once) the sign-in started with this state; null when unknown or older than 15 minutes. */
export function takeStorageSignIn(state: string, now = Date.now()): PendingStorage | null {
  const p = pending.get(state);
  pending.delete(state);
  return p && now - p.at <= PENDING_TTL_MS ? p : null;
}
