import 'server-only';
import { headers } from 'next/headers';
import { createSupabaseServer } from '@/lib/supabase/server';
import { totpState } from '@/lib/auth/mfaServer';
import { brainJson, brainResource } from '@/lib/brainConnector';

// Brain connector consent (docs/16-BRAIN.md "Connector"): the checks shared by the page and its approve action.
// The client and redirect URI are checked first: when they fail, nothing redirects anywhere (an unknown redirect_uri
// must never receive a response, RFC 6749 §4.1.2.1). After that, protocol errors go back to the client as ?error=.

export interface AuthorizeParams {
  response_type: string; client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: string;
  state: string; scope: string; resource: string;
}
export const PARAM_NAMES = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'] as const;

export function readParams(get: (name: string) => unknown): AuthorizeParams {
  const one = (n: string) => { const v = get(n); const s = Array.isArray(v) ? v[0] : v; return typeof s === 'string' ? s.slice(0, 1000) : ''; };
  return Object.fromEntries(PARAM_NAMES.map((n) => [n, one(n)])) as unknown as AuthorizeParams;
}

export const queryOf = (p: AuthorizeParams) => new URLSearchParams(Object.entries(p).filter(([, v]) => v)).toString();

export interface ClientInfo { client_id: string; client_name: string; client_uri: string | null; redirect_uri: string }

export type Check =
  | { kind: 'fatal'; message: string }                                   // show an error page, never redirect
  | { kind: 'client_error'; redirect: string }                           // bounce back to the client with ?error=
  | { kind: 'login'; to: string }                                        // HQ sign-in (or its 2FA step) first
  | { kind: 'ok'; client: ClientInfo; userId: string; origin: string; wantsWrite: boolean };

export function withParams(uri: string, params: Record<string, string>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

async function requestLike() {
  const h = await headers();
  return { url: 'http://localhost/', headers: { get: (n: string) => h.get(n) } };
}

export async function checkAuthorize(p: AuthorizeParams): Promise<Check> {
  const chk = await brainJson<ClientInfo>(`/oauth/client?client_id=${encodeURIComponent(p.client_id)}&redirect_uri=${encodeURIComponent(p.redirect_uri)}`);
  if (chk.status === 0) return { kind: 'fatal', message: chk.body.error ?? 'The brain service is not reachable.' };
  if (chk.status !== 200) return { kind: 'fatal', message: 'This app is not registered with the HQ Brain, or its return address does not match. Remove the connector in Claude and add it again.' };
  const client = chk.body;
  const origin = new URL(brainResource(await requestLike())).origin;
  const back = (error: string, description: string): Check => ({
    kind: 'client_error', redirect: withParams(p.redirect_uri, { error, error_description: description, state: p.state, iss: origin }),
  });
  if (p.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code');
  if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) return back('invalid_request', 'PKCE with S256 is required');
  if (p.resource && p.resource.replace(/\/+$/, '') !== brainResource(await requestLike())) return back('invalid_target', 'unknown resource');

  const db = await createSupabaseServer();
  if (!db) return { kind: 'fatal', message: 'HQ sign-in is not configured (demo mode).' };
  const next = `/oauth/authorize?${queryOf(p)}`;
  const state = await totpState(db);
  if (!state) return { kind: 'login', to: `/login?next=${encodeURIComponent(next)}` };
  if (state.factorId && state.currentLevel !== 'aal2') return { kind: 'login', to: `/login?step=totp&next=${encodeURIComponent(next)}` };
  if (!state.factorId) return { kind: 'fatal', message: 'Turn on two-factor sign-in first (Admin → Security). The Brain holds all your project memory, so connecting it needs 2FA.' };
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { kind: 'login', to: `/login?next=${encodeURIComponent(next)}` };
  const ceo = await db.from('ceo_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!ceo.data) return { kind: 'fatal', message: 'Only the CEO account can connect the Brain.' };
  const asked = p.scope.split(/\s+/).filter(Boolean);
  const wantsWrite = !asked.some((s) => s.startsWith('brain:')) || asked.includes('brain:write');
  return { kind: 'ok', client, userId: user.id, origin, wantsWrite };
}
