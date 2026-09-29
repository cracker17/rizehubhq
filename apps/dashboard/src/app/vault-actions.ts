'use server';
// Client Vault server actions (docs/06 §7a, docs/09 "Client Vault").
// * Every CEO action verifies the signed-in session is the CEO (ceo_users) before doing anything.
// * Secrets only travel browser → this server action → worker (/vault/store, /vault/rotate) over the private
//   network; they are never stored, logged or returned here. The one exception is Reveal, which requires the
//   CEO to re-enter their password and returns the plaintext to that browser only (shown 30 s, logged by the worker).
// * State changes that don't involve a secret go through the vault RPCs as the CEO (RLS + hq_guard apply).
// * The public access form (submitAccessAction) needs no session: it is rate-limited here, validated, and the
//   worker verifies the one-time token.
import { createHash, randomBytes } from 'node:crypto';
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv, workerEnv } from '@/lib/env';
import { CRED_COLS, PLATFORMS, type CredentialView, type SecretType, type TwofaMethod } from '@/lib/data/vault';
import { demoVault } from '@/lib/data/vaultDemo';
import { ensureStepUp } from '@/lib/auth/mfaServer';
import { clientIp, dashboardOrigin, passwordMatches } from '@/lib/auth/reauth';
import { rateLimited, type Tries } from '@/lib/auth/rateLimit';

export type VaultResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; stepUp?: boolean };

const SECRET_TYPES: SecretType[] = ['password', 'api_token', 'app_password', 'ssh_key', 'other'];
const TWOFA: TwofaMethod[] = ['none', 'sms', 'email', 'app', 'collaborator'];
const ID = /^[A-Za-z0-9-]{1,64}$/;
const AGENT = /^[a-z0-9-]{1,64}$/;
const PLATFORM = /^[a-z0-9][a-z0-9_-]{0,39}$/;

// ---------- helpers ----------
function friendly(message: string): string {
  if (/not allowed|permission denied|42501/i.test(message)) return 'This account is not allowed to do that (not the CEO).';
  if (/JWT|session/i.test(message)) return 'Your session expired. Sign in again.';
  return message.replace(/^vault_\w+: /, '');
}

type Ceo = { demo: true } | { demo: false; db: NonNullable<Awaited<ReturnType<typeof createSupabaseServer>>>; userId: string; email: string | null };

/** DEMO → { demo }. LIVE → the CEO's own Supabase client, or an error when not signed in / not the CEO. */
async function requireCeo(): Promise<Ceo | { error: string }> {
  if (!supabaseEnv()) return { demo: true };
  const db = await createSupabaseServer();
  if (!db) return { error: 'Supabase is not configured.' };
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };
  const ceo = await db.from('ceo_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!ceo.data) return { error: 'This account is not the CEO.' };
  return { demo: false, db, userId: user.id, email: user.email ?? null };
}

async function callWorker<T>(path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: T & { error?: string } } | { status: 0; body: { error: string } }> {
  const worker = workerEnv();
  if (!worker) return { status: 0, body: { error: 'The worker is not configured (HQ_WORKER_URL / HQ_INTERNAL_SECRET).' } };
  try {
    const res = await fetch(`${worker.url}${path}`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', 'x-hq-secret': worker.secret, ...extraHeaders },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({ error: `Worker answered ${res.status}` }))) as T & { error?: string } };
  } catch {
    return { status: 0, body: { error: 'Could not reach the worker. Is it running?' } };
  }
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function normUrl(v: unknown): string | null | false {
  const t = text(v, 2000);
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    if (u.username || u.password) return false;
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) return false;
    return u.toString();
  } catch { return false; }
}

function allowlist(v: unknown): string[] | false {
  const lines = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,]/) : []).map((x) => String(x).trim()).filter(Boolean);
  if (lines.length > 25) return false;
  const out: string[] = [];
  for (const l of lines) {
    const u = normUrl(l.replace(/\*+$/, ''));
    if (!u) return false;
    out.push(u.replace(/\/$/, l.endsWith('/') ? '/' : ''));
  }
  return out;
}

/** "PUT /admin/api/2025-07/themes/123/assets.json" per line (POST/PUT/PATCH + a path or https URL); max 25. */
const WRITE_ENTRY = /^(POST|PUT|PATCH) (\/|https:\/\/)\S{0,500}$/;
function writeAllowlist(v: unknown): string[] | false {
  const lines = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\n/) : []).map((x) => String(x).trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (lines.length > 25) return false;
  const out = lines.map((l) => l.replace(/^(post|put|patch)\b/i, (m) => m.toUpperCase()));
  return out.every((l) => WRITE_ENTRY.test(l)) ? out : false;
}

function grantsOf(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.map(String).filter((a) => AGENT.test(a)))].slice(0, 40) : [];
}

function expiry(v: unknown): string | null | false {
  const t = text(v, 40);
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t))) return false;
  return `${t}T00:00:00+08:00`;
}

// ---------- credentials ----------
export interface CredentialInput {
  clientId: string;
  platform: string;
  label: string;
  loginUrl?: string | null;
  username?: string | null;
  secretType: SecretType;
  twofaMethod: TwofaMethod;
  scopeNotes?: string | null;
  urlAllowlist?: string[] | string;
  /** vault_api writes; empty = read-only. */
  writeAllowlist?: string[] | string;
  expiresAt?: string | null;
  grants?: string[];
}

function validateMeta(i: CredentialInput): { error: string } | {
  platform: string; label: string; loginUrl: string | null; username: string | null; secretType: SecretType; twofaMethod: TwofaMethod;
  scopeNotes: string | null; urlAllowlist: string[]; writeAllowlist: string[]; expiresAt: string | null; grants: string[];
} {
  const platform = String(i.platform ?? '').trim().toLowerCase();
  if (!PLATFORM.test(platform)) return { error: 'Pick a platform.' };
  const label = text(i.label, 120);
  if (!label) return { error: 'Give it a label, e.g. "Madam Muse · Shopify collaborator".' };
  const loginUrl = normUrl(i.loginUrl);
  if (loginUrl === false) return { error: 'The login URL must be an https URL.' };
  const urls = allowlist(i.urlAllowlist);
  if (urls === false) return { error: 'Allowed URLs: one https URL per line (max 25).' };
  const writes = writeAllowlist(i.writeAllowlist);
  if (writes === false) return { error: 'Allowed API writes: one "PUT /path" per line (POST, PUT or PATCH; max 25).' };
  const exp = expiry(i.expiresAt);
  if (exp === false) return { error: 'Expiry must be a date.' };
  return {
    platform, label, loginUrl, username: text(i.username, 200),
    secretType: SECRET_TYPES.includes(i.secretType) ? i.secretType : 'password',
    twofaMethod: TWOFA.includes(i.twofaMethod) ? i.twofaMethod : 'none',
    scopeNotes: text(i.scopeNotes, 2000), urlAllowlist: urls, writeAllowlist: writes, expiresAt: exp, grants: grantsOf(i.grants),
  };
}

export async function storeCredentialAction(input: CredentialInput & { secret: string }): Promise<VaultResult<{ id: string }>> {
  if (!ID.test(String(input.clientId ?? ''))) return { ok: false, error: 'Unknown client.' };
  const m = validateMeta(input);
  if ('error' in m) return { ok: false, error: m.error };
  const secret = typeof input.secret === 'string' ? input.secret : '';
  if (!secret.trim()) return { ok: false, error: 'Enter the password or token.' };
  if (secret.length > 8000) return { ok: false, error: 'That secret is too long (max 8,000 characters).' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) {
    // DEMO keeps no secret at all.
    const id = demoVault().addCredential({
      client_id: input.clientId, platform: m.platform, label: m.label, login_url: m.loginUrl, username: m.username,
      secret_type: m.secretType, twofa_method: m.twofaMethod, scope_notes: m.scopeNotes, url_allowlist: m.urlAllowlist,
      write_allowlist: m.writeAllowlist, expires_at: m.expiresAt, created_by: 'ceo', grants: m.grants,
    });
    return { ok: true, id };
  }
  const r = await callWorker<{ id: string }>('/vault/store', { clientId: input.clientId, ...m, secret });
  if (r.status !== 200) return { ok: false, error: friendly(r.body.error ?? 'Could not store it.') };
  return { ok: true, id: r.body.id };
}

export async function updateCredentialAction(input: CredentialInput & { id: string }): Promise<VaultResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown credential.' };
  const m = validateMeta(input);
  if ('error' in m) return { ok: false, error: m.error };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) {
    try {
      demoVault().updateCredential(input.id, {
        platform: m.platform, label: m.label, login_url: m.loginUrl, username: m.username, twofa_method: m.twofaMethod,
        scope_notes: m.scopeNotes, url_allowlist: m.urlAllowlist, write_allowlist: m.writeAllowlist, expires_at: m.expiresAt,
      });
      demoVault().updateCredential(input.id, { grants: m.grants });
      return { ok: true };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Failed.' }; }
  }
  const up = await ceo.db.rpc('vault_update_credential', {
    p_id: input.id, p_label: m.label, p_login_url: m.loginUrl, p_username: m.username, p_twofa: m.twofaMethod,
    p_scope_notes: m.scopeNotes, p_url_allowlist: m.urlAllowlist, p_expires_at: m.expiresAt, p_platform: m.platform, p_status: null,
    p_write_allowlist: m.writeAllowlist,
  });
  if (up.error) return { ok: false, error: friendly(up.error.message) };
  return setGrantsAction({ id: input.id, agents: m.grants });
}

export async function setGrantsAction(input: { id: string; agents: string[] }): Promise<VaultResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown credential.' };
  const agents = grantsOf(input.agents);
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) {
    try { demoVault().updateCredential(input.id, { grants: agents }); return { ok: true }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Failed.' }; }
  }
  const r = await ceo.db.rpc('vault_set_grants', { p_credential: input.id, p_agents: agents });
  return r.error ? { ok: false, error: friendly(r.error.message) } : { ok: true };
}

export async function rotateSecretAction(input: { id: string; secret: string }): Promise<VaultResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown credential.' };
  const secret = typeof input.secret === 'string' ? input.secret : '';
  if (!secret.trim()) return { ok: false, error: 'Enter the new password or token.' };
  if (secret.length > 8000) return { ok: false, error: 'That secret is too long.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) {
    try { demoVault().rotate(input.id); return { ok: true }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Failed.' }; }
  }
  const r = await callWorker('/vault/rotate', { id: input.id, secret });
  return r.status === 200 ? { ok: true } : { ok: false, error: friendly(r.body.error ?? 'Could not rotate it.') };
}

export async function revokeCredentialAction(input: { id: string; reason?: string | null }): Promise<VaultResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown credential.' };
  const reason = text(input.reason, 300);
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) { demoVault().revoke(input.id, reason); return { ok: true }; }
  const r = await ceo.db.rpc('vault_revoke', { p_credential: input.id, p_reason: reason });
  return r.error ? { ok: false, error: friendly(r.error.message) } : { ok: true };
}

/** "Check needed" → active again after the CEO fixed it at the platform (without changing the secret). */
export async function reactivateCredentialAction(input: { id: string }): Promise<VaultResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown credential.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) {
    try { demoVault().updateCredential(input.id, { status: 'active', failed_login_count: 0 }); return { ok: true }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Failed.' }; }
  }
  const cur = await ceo.db.from('client_credentials').select(CRED_COLS).eq('id', input.id).maybeSingle();
  const c = cur.data as unknown as CredentialView | null;
  if (cur.error || !c) return { ok: false, error: friendly(cur.error?.message ?? 'Unknown credential.') };
  const r = await ceo.db.rpc('vault_update_credential', {
    p_id: c.id, p_label: c.label, p_login_url: c.login_url, p_username: c.username, p_twofa: c.twofa_method,
    p_scope_notes: c.scope_notes, p_url_allowlist: c.url_allowlist ?? [], p_expires_at: c.expires_at, p_platform: null, p_status: 'active',
  });
  return r.error ? { ok: false, error: friendly(r.error.message) } : { ok: true };
}

// Reveal: re-authentication + a small per-user limiter (in memory, per server process).
const revealTries: Tries = new Map();

export async function revealSecretAction(input: { id: string; password: string; totp?: string | null }): Promise<VaultResult<{ label: string; secret: string; showMs: number }>> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown credential.' };
  const password = typeof input.password === 'string' ? input.password : '';
  if (!password) return { ok: false, error: 'Enter your password to reveal.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) {
    try { return { ok: true, ...demoVault().reveal(input.id), showMs: 30_000 }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Failed.' }; }
  }
  // 2FA on → a TOTP code is required for every reveal (docs/06 "Auth"), checked before the password attempt counts.
  const step = await ensureStepUp(ceo.db, (s) => (s.factorId ? 'required' : 'not_needed'), input.totp);
  if (!step.ok) return step;
  if (rateLimited(revealTries, ceo.userId, 5, 10 * 60_000)) return { ok: false, error: 'Too many reveal attempts. Wait 10 minutes.' };
  if (!ceo.email) return { ok: false, error: 'Your account has no email to re-authenticate with.' };
  if (!(await passwordMatches(ceo.email, password, ceo.userId))) return { ok: false, error: 'Wrong password.' };
  const r = await callWorker<{ label: string; secret: string }>('/vault/reveal', { id: input.id });
  if (r.status !== 200 || !('secret' in r.body)) return { ok: false, error: friendly(r.body.error ?? 'Could not reveal it.') };
  return { ok: true, label: r.body.label, secret: r.body.secret, showMs: 30_000 };
}

// ---------- secure client links ----------
export async function createAccessLinkAction(input: { clientId: string; platforms: string[]; note?: string | null }): Promise<VaultResult<{ url: string; expiresAt: string }>> {
  if (!ID.test(String(input.clientId ?? ''))) return { ok: false, error: 'Unknown client.' };
  const platforms = [...new Set((input.platforms ?? []).map((p) => String(p).toLowerCase()).filter((p) => PLATFORM.test(p)))].slice(0, 10);
  if (!platforms.length) return { ok: false, error: 'Pick at least one platform.' };
  const note = text(input.note, 500);
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  const base = await dashboardOrigin();
  if (ceo.demo) {
    try {
      const { token, expires_at } = demoVault().createLink(input.clientId, platforms, note);
      return { ok: true, url: `${base}/access/${token}`, expiresAt: expires_at };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Failed.' }; }
  }
  // The token is shown once (in this response) and only its hash is stored.
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const r = await ceo.db.rpc('create_access_request', { p_client: input.clientId, p_platforms: platforms, p_token_hash: hash, p_hours: 72, p_note: note });
  if (r.error) return { ok: false, error: friendly(r.error.message) };
  const row = (Array.isArray(r.data) ? r.data[0] : r.data) as { expires_at: string } | null;
  return { ok: true, url: `${base}/access/${token}`, expiresAt: row?.expires_at ?? new Date(Date.now() + 72 * 3600_000).toISOString() };
}

export async function cancelAccessLinkAction(input: { id: string }): Promise<VaultResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown link.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) { demoVault().cancelLink(input.id); return { ok: true }; }
  const r = await ceo.db.rpc('vault_cancel_access_request', { p_id: input.id });
  return r.error ? { ok: false, error: friendly(r.error.message) } : { ok: true };
}

// ---------- clients ----------
export interface ClientProfileInput {
  id: string; name: string; website?: string | null; platforms: string[]; service_package?: string | null; notes?: string | null;
  rizehub_workspace_id?: string | null; status?: 'active' | 'paused';
}

export async function updateClientAction(input: ClientProfileInput): Promise<VaultResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown client.' };
  const name = text(input.name, 120);
  if (!name) return { ok: false, error: 'The client needs a name.' };
  const website = normUrl(input.website);
  if (website === false) return { ok: false, error: 'Website must be an https URL.' };
  const patch = {
    name, website, platforms: [...new Set((input.platforms ?? []).map((p) => String(p).toLowerCase()).filter((p) => PLATFORM.test(p)))].slice(0, 12),
    service_package: text(input.service_package, 80), notes: text(input.notes, 4000), rizehub_workspace_id: text(input.rizehub_workspace_id, 120),
    ...(input.status === 'active' || input.status === 'paused' ? { status: input.status } : {}),
  };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) {
    try { demoVault().updateClient(input.id, patch); return { ok: true }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Failed.' }; }
  }
  const r = await ceo.db.from('clients').update(patch).eq('id', input.id);
  return r.error ? { ok: false, error: friendly(r.error.message) } : { ok: true };
}

/** Archiving revokes every agent grant and open access link (DB trigger). */
export async function archiveClientAction(input: { id: string }): Promise<VaultResult> {
  if (!ID.test(String(input.id ?? ''))) return { ok: false, error: 'Unknown client.' };
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) { demoVault().updateClient(input.id, { status: 'archived' }); return { ok: true }; }
  const r = await ceo.db.from('clients').update({ status: 'archived' }).eq('id', input.id);
  return r.error ? { ok: false, error: friendly(r.error.message) } : { ok: true };
}

export async function createClientAction(input: { name: string; website?: string | null; platforms: string[]; service_package?: string | null }): Promise<VaultResult<{ id: string }>> {
  const name = text(input.name, 120);
  if (!name) return { ok: false, error: 'The client needs a name.' };
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  if (!slug) return { ok: false, error: 'Use letters or numbers in the name.' };
  const website = normUrl(input.website);
  if (website === false) return { ok: false, error: 'Website must be an https URL.' };
  const platforms = [...new Set((input.platforms ?? []).map((p) => String(p).toLowerCase()).filter((p) => PLATFORM.test(p)))].slice(0, 12);
  const service_package = text(input.service_package, 80);
  const ceo = await requireCeo();
  if ('error' in ceo) return { ok: false, error: ceo.error };
  if (ceo.demo) {
    try { return { ok: true, id: demoVault().addClient({ name, slug, website, platforms, service_package }) }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Failed.' }; }
  }
  const r = await ceo.db.from('clients').insert({ name, slug, website, platforms, service_package }).select('id').single();
  if (r.error) return { ok: false, error: /duplicate|unique/i.test(r.error.message) ? 'A client with that name/slug exists.' : friendly(r.error.message) };
  return { ok: true, id: (r.data as { id: string }).id };
}

// ---------- the client's public form (no session) ----------
const accessTries: Tries = new Map();
export interface AccessFormState { status: 'idle' | 'ok' | 'error' | 'closed'; error?: string }

export async function submitAccessAction(_prev: AccessFormState, form: FormData): Promise<AccessFormState> {
  const ip = await clientIp();
  if (rateLimited(accessTries, ip, 10, 10 * 60_000) || rateLimited(accessTries, '*', 200, 10 * 60_000)) {
    return { status: 'error', error: 'Too many attempts. Please wait a few minutes and try again.' };
  }
  const token = String(form.get('token') ?? '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return { status: 'closed' };
  const platform = String(form.get('platform') ?? '').toLowerCase();
  if (!PLATFORM.test(platform) || !(PLATFORMS as readonly string[]).includes(platform)) return { status: 'error', error: 'Choose the platform.' };
  const loginUrl = normUrl(form.get('loginUrl'));
  if (loginUrl === false) return { status: 'error', error: 'The login URL should start with https://' };
  const username = text(form.get('username'), 200);
  const secret = String(form.get('secret') ?? '');
  if (!secret.trim()) return { status: 'error', error: 'Enter the password or token.' };
  if (secret.length > 8000) return { status: 'error', error: 'That is too long for a password or token.' };
  const secretType = SECRET_TYPES.includes(form.get('secretType') as SecretType) ? (form.get('secretType') as SecretType) : 'password';
  const twofaMethod = TWOFA.includes(form.get('twofaMethod') as TwofaMethod) ? (form.get('twofaMethod') as TwofaMethod) : 'none';
  const notes = text(form.get('notes'), 2000);
  const label = text(form.get('label'), 120);

  if (!supabaseEnv()) {
    try {
      return demoVault().redeem(token, { platform, label, loginUrl, username, secretType, twofaMethod, notes }) ? { status: 'ok' } : { status: 'closed' };
    } catch (e) {
      return { status: 'error', error: e instanceof Error && /platform/.test(e.message) ? 'That platform was not requested in this link.' : 'Something went wrong.' };
    }
  }
  const r = await callWorker('/vault/access', { token, platform, label, loginUrl, username, secretType, secret, twofaMethod, notes }, { 'x-client-ip': ip });
  if (r.status === 200) return { status: 'ok' };
  if (r.status === 410) return { status: 'closed' };
  if (r.status === 429) return { status: 'error', error: 'Too many attempts. Please wait a few minutes and try again.' };
  if (r.status === 409) return { status: 'error', error: 'That platform was not requested in this link.' };
  if (r.status === 400) return { status: 'error', error: 'Please check the fields and try again.' };
  return { status: 'error', error: 'We could not save this right now. Please try again in a moment.' };
}
