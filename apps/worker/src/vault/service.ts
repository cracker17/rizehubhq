// Vault operations behind the worker's internal HTTP routes (routes/vault.ts):
// store / rotate / reveal for the CEO dashboard, and the client's self-serve access link.
// Plaintext exists only in memory here; it is never logged or written anywhere but the sealed columns.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { open, seal, type Keyring } from './crypto';
import { parseAllowEntry, safeUrl } from './guards';
import type { AccessLinkState, VaultStore } from './store';

export const PLATFORM = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'unknown platform');
const SECRET_TYPES = ['password', 'api_token', 'app_password', 'ssh_key', 'other'] as const;
const TWOFA = ['none', 'sms', 'email', 'app', 'collaborator'] as const;
const httpUrl = z.string().trim().max(2000).refine((v) => v === '' || normUrl(v) !== null, 'must be an https URL');
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export const StoreInput = z.object({
  clientId: z.string().uuid(),
  platform: PLATFORM,
  label: z.string().trim().min(1).max(120),
  loginUrl: httpUrl.nullish().transform((v) => normUrl(v)),
  username: optText(200),
  secretType: z.enum(SECRET_TYPES).default('password'),
  secret: z.string().min(1).max(8000),
  twofaMethod: z.enum(TWOFA).default('none'),
  scopeNotes: optText(2000),
  urlAllowlist: z.array(z.string().trim().max(500).refine((v) => parseAllowEntry(v) !== null, 'invalid allowlist entry')).max(25).default([]),
  expiresAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish().transform((v) => v ?? null),
  grants: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).max(40).default([]),
});
export type StoreInput = z.input<typeof StoreInput>;

export const RotateInput = z.object({ id: z.string().uuid(), secret: z.string().min(1).max(8000) });
export const RevealInput = z.object({ id: z.string().uuid() });

export const TOKEN = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, 'invalid link');
export const AccessInput = z.object({
  token: TOKEN,
  platform: PLATFORM,
  label: z.string().trim().max(120).nullish(),
  loginUrl: httpUrl.nullish().transform((v) => normUrl(v)),
  username: optText(200),
  secretType: z.enum(SECRET_TYPES).default('password'),
  secret: z.string().min(1).max(8000),
  twofaMethod: z.enum(TWOFA).default('none'),
  notes: optText(2000),
});
export const AccessStateInput = z.object({ token: TOKEN });

function normUrl(v: string | null | undefined): string | null {
  if (!v) return null;
  return (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? safeUrl(v) : safeUrl(`https://${v}`))?.toString() ?? null;
}

/** Zod issues without values (a secret must never end up in an error message). */
export function issuesText(e: z.ZodError): string {
  return e.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'body'}: ${i.path.includes('secret') ? 'required (max 8000 characters)' : i.message}`).join('; ');
}

export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class VaultUnavailable extends Error {}

export interface VaultService {
  store(input: z.output<typeof StoreInput>): Promise<{ id: string }>;
  rotate(id: string, secret: string): Promise<void>;
  reveal(id: string): Promise<{ label: string; secret: string }>;
  accessState(token: string): Promise<AccessLinkState>;
  /** false for any bad token (unknown, used, cancelled, expired). */
  redeem(input: z.output<typeof AccessInput>): Promise<{ ok: true; id: string } | { ok: false }>;
}

export function createVaultService(store: VaultStore, keyring: Keyring | null): VaultService {
  const kr = () => {
    if (!keyring) throw new VaultUnavailable('VAULT_MASTER_KEY is not configured on the worker');
    return keyring;
  };

  return {
    async store(i) {
      const id = randomUUID();
      const sealed = seal(i.secret, kr(), id);
      await store.insertCredential({
        id, clientId: i.clientId, platform: i.platform, label: i.label, loginUrl: i.loginUrl, username: i.username,
        secretType: i.secretType, sealed, twofaMethod: i.twofaMethod, scopeNotes: i.scopeNotes, urlAllowlist: i.urlAllowlist,
        expiresAt: i.expiresAt, grants: i.grants,
      });
      return { id };
    },
    async rotate(id, secret) {
      const cur = await store.getSealed(id);
      if (!cur) throw new Error('credential not found');
      await store.rotateSecret(id, seal(secret, kr(), id));
    },
    async reveal(id) {
      const cur = await store.getSealed(id);
      if (!cur) throw new Error('credential not found');
      let secret: string;
      try {
        secret = open(cur.sealed, kr(), id);
      } catch (e) {
        await store.logAccess({ credentialId: id, agentId: 'ceo', taskId: null, action: 'reveal', success: false, detail: { via: 'dashboard', error: 'decrypt_failed' } });
        throw e;
      }
      await store.logAccess({ credentialId: id, agentId: 'ceo', taskId: null, action: 'reveal', success: true, detail: { via: 'dashboard' } });
      return { label: cur.label, secret };
    },
    accessState: (token) => store.accessRequestState(hashAccessToken(token)),
    async redeem(i) {
      const id = randomUUID();
      const sealed = seal(i.secret, kr(), id);
      const label = i.label?.trim() || `${i.platform[0]!.toUpperCase()}${i.platform.slice(1)} access (from client)`;
      const created = await store.redeemAccessRequest(hashAccessToken(i.token), {
        id, platform: i.platform, label, loginUrl: i.loginUrl, username: i.username, secretType: i.secretType, sealed,
        twofaMethod: i.twofaMethod, scopeNotes: i.notes,
      });
      return created ? { ok: true, id: created } : { ok: false };
    },
  };
}
