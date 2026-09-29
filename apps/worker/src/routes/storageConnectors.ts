// Admin → Connectors → Storage (docs/15 §6). The dashboard (CEO + 2FA checked there) starts a Google Drive / Dropbox
// sign-in with the CEO's own OAuth app (client ID + secret), the shared callback hands the code back here (states start
// with "st_"), and the worker exchanges it (PKCE), checks the account, seals client + refresh token and stores a
// `connectors` row of kind 'storage'. Test = forced token refresh + account read. Secrets are never logged or returned.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MCP_CALLBACK_PATH, STORAGE_INFO, STORAGE_ROOT_FOLDER } from '@rizehubhq/shared';
import type { Route } from './types';
import { workerEnv } from '../config';
import { createServiceClient } from '../db';
import { loadKeyring, seal, type Keyring } from '../vault/crypto';
import { connectorContext, createSupabaseConnectorStore, type ConnectorStore } from '../connectors/store';
import { accountOf, openStorage, rememberAccessToken, StorageUnavailable, type StorageEnv } from '../connectors/storage';
import { exchangeCode, startStorageSignIn, StorageNeedsReauth, takeStorageSignIn, type Fetch } from '../connectors/storageOAuth';

const Start = z.object({
  provider: z.enum(['drive', 'dropbox']),
  clientId: z.string().trim().min(8).max(300).regex(/^[\w.\-]+$/, 'That client ID has unexpected characters.'),
  clientSecret: z.string().trim().min(8).max(500),
  name: z.string().max(120).optional(),
  /** Dropbox: the app folder name (= the app's name) for web links. */
  appFolder: z.string().max(100).optional(),
});
const Finish = z.object({ state: z.string().min(20).max(100), code: z.string().min(1).max(4000) });
const Test = z.object({ id: z.string().uuid() });

export interface StorageRouteDeps {
  store: () => ConnectorStore;
  keyring: () => Keyring | null;
  publicUrl: () => string;
  fetch?: Fetch;
}

function parse<S extends z.ZodTypeAny>(schema: S, raw: Buffer): z.output<S> | string {
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return 'invalid JSON'; }
  const r = schema.safeParse(body);
  return r.success ? (r.data as z.output<S>) : (r.error.issues[0]?.message ?? 'invalid input');
}

const friendly = (e: unknown, provider: string) => {
  const vendor = provider === 'drive' ? 'Google' : 'Dropbox';
  const m = e instanceof Error ? e.message : String(e);
  if (e instanceof StorageNeedsReauth) {
    if (/invalid_client|unauthorized_client/i.test(m)) return `${vendor} rejected the client ID or secret. Check them and try again.`;
    return `${vendor} refused the sign-in (${m.slice(0, 160)}). Start again.`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed out|timeout/i.test(m)) return `Could not reach ${vendor}. Try again in a minute.`;
  return m.slice(0, 300);
};

export function createStorageConnectorRoutes(d: StorageRouteDeps): Route[] {
  const noKey: [number, unknown] = [503, { error: 'The worker cannot encrypt secrets: VAULT_MASTER_KEY is not set.' }];
  const fetchFn: Fetch = d.fetch ?? ((...a) => fetch(...a));
  const env = (): StorageEnv => ({ store: d.store(), keyring: d.keyring(), fetch: fetchFn });
  return [
    {
      method: 'POST', path: '/connectors/storage/start', auth: 'secret',
      handle: async (_req, raw) => {
        const b = parse(Start, raw);
        if (typeof b === 'string') return [400, { error: b }];
        if (!d.keyring()) return noKey;
        const s = startStorageSignIn({
          provider: b.provider, clientId: b.clientId, clientSecret: b.clientSecret,
          name: b.name?.trim() || STORAGE_INFO[b.provider].name, appFolder: b.provider === 'dropbox' ? (b.appFolder?.trim() || STORAGE_ROOT_FOLDER) : null,
          redirectUri: `${d.publicUrl()}${MCP_CALLBACK_PATH}`,
        });
        return [200, { authorizeUrl: s.authorizeUrl }];
      },
    },
    {
      method: 'POST', path: '/connectors/storage/finish', auth: 'secret',
      handle: async (_req, raw) => {
        const b = parse(Finish, raw);
        if (typeof b === 'string') return [400, { error: b }];
        const kr = d.keyring();
        if (!kr) return noKey;
        const p = takeStorageSignIn(b.state);
        if (!p) return [400, { error: 'This sign-in expired or was already used. Start again from Admin → Connectors.' }];
        try {
          const t = await exchangeCode(fetchFn, { provider: p.provider, clientId: p.clientId, clientSecret: p.clientSecret, code: b.code, redirectUri: p.redirectUri, verifier: p.verifier });
          const id = randomUUID();
          // Which account signed in (shown on the card); not fatal: Dropbox apps without account_info.read still save.
          const account = await accountOf(fetchFn, p.provider, t.accessToken).catch(() => null);
          const email = account && /^[^\s@]+@[^\s@]+$/.test(account) ? account : null;
          await d.store().insert({
            id, kind: 'storage', name: p.name, accountEmail: email, url: null, authType: 'oauth',
            settings: { provider: p.provider, ...(p.appFolder ? { appFolder: p.appFolder } : {}) },
            sealed: seal(JSON.stringify(t.secret), kr, connectorContext(id)), grants: [], catalogKey: p.provider,
          });
          rememberAccessToken(id, t.accessToken, t.expiresAt);
          return [200, { id, name: p.name, provider: p.provider, account }];
        } catch (e) {
          return [400, { error: friendly(e, p.provider) }];
        }
      },
    },
    {
      method: 'POST', path: '/connectors/storage/test', auth: 'secret',
      handle: async (_req, raw) => {
        const b = parse(Test, raw);
        if (typeof b === 'string') return [400, { error: b }];
        if (!d.keyring()) return noKey;
        let provider = 'drive';
        try {
          const s = await openStorage(env(), b.id);
          if (!s) return [404, { error: 'Unknown storage connection.' }];
          provider = s.provider;
          const account = await s.check();
          await d.store().mark(b.id, 'active', null, false).catch(() => undefined);
          return [200, { ok: true, account }];
        } catch (e) {
          if (!(e instanceof StorageNeedsReauth)) await d.store().mark(b.id, 'error', friendly(e, provider)).catch(() => undefined);
          return [200, { ok: false, error: e instanceof StorageUnavailable ? e.message : friendly(e, provider) }];
        }
      },
    },
  ];
}

let store: ConnectorStore | null = null;
export const storageConnectorRoutes: Route[] = createStorageConnectorRoutes({
  store: () => (store ??= createSupabaseConnectorStore(createServiceClient())),
  keyring: () => loadKeyring(workerEnv()),
  publicUrl: () => (workerEnv().DASHBOARD_URL ?? 'https://hq.rizehub.ph').replace(/\/+$/, ''),
});
