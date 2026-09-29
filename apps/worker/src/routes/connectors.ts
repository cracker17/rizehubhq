// Admin → Connectors (docs/15): the dashboard server adds a Gmail account, replaces its App Password, or tests a
// connector. x-hq-secret like every dashboard → worker call; the CEO check (and 2FA step-up) happens in the dashboard
// before it calls here. The App Password is tested against Gmail before it is sealed and stored; it is never logged
// or returned.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Route } from './types';
import { workerEnv } from '../config';
import { createServiceClient } from '../db';
import { loadKeyring, open, seal, type Keyring } from '../vault/crypto';
import { connectorContext, createSupabaseConnectorStore, type ConnectorStore } from '../connectors/store';
import { isGmailAddress, normalizeAppPassword, testGmailLogin } from '../connectors/gmail';

const AGENT = /^[a-z0-9-]{1,64}$/;
const AddGmail = z.object({
  email: z.string().max(254),
  appPassword: z.string().max(64),
  name: z.string().max(120).optional(),
  agents: z.array(z.string().regex(AGENT)).max(10).default([]),
  mode: z.enum(['read', 'read_draft']).default('read'),
});
const Replace = z.object({ id: z.string().uuid(), appPassword: z.string().max(64) });
const Test = z.object({ id: z.string().uuid() });

export interface ConnectorRouteDeps {
  store: () => ConnectorStore;
  keyring: () => Keyring | null;
  test?: typeof testGmailLogin;
}

function parse<S extends z.ZodTypeAny>(schema: S, raw: Buffer): z.output<S> | string {
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return 'invalid JSON'; }
  const r = schema.safeParse(body);
  return r.success ? (r.data as z.output<S>) : (r.error.issues[0]?.message ?? 'invalid input');
}

export function createConnectorRoutes(d: ConnectorRouteDeps): Route[] {
  const test = d.test ?? testGmailLogin;
  const noKey: [number, unknown] = [503, { error: 'The worker cannot encrypt secrets: VAULT_MASTER_KEY is not set.' }];
  return [
    {
      method: 'POST', path: '/connectors/gmail/add', auth: 'secret',
      handle: async (_req, raw) => {
        const b = parse(AddGmail, raw);
        if (typeof b === 'string') return [400, { error: b }];
        const email = b.email.trim().toLowerCase();
        if (!isGmailAddress(email)) return [400, { error: 'Use a @gmail.com address.' }];
        const pass = normalizeAppPassword(b.appPassword);
        if (!pass) return [400, { error: 'An App Password is 16 letters (Google shows it in 4 groups of 4). Your normal Gmail password won’t work.' }];
        const kr = d.keyring();
        if (!kr) return noKey;
        const t = await test(email, pass);
        if (!t.ok) return [400, { error: t.error }];
        const id = randomUUID();
        try {
          await d.store().insert({
            id, kind: 'gmail', name: b.name?.trim() || email, accountEmail: email, url: null, authType: 'app_password',
            settings: { mode: b.mode }, sealed: seal(pass, kr, connectorContext(id)), grants: b.agents, catalogKey: 'gmail',
          });
        } catch (e) {
          const m = e instanceof Error ? e.message : '';
          return [409, { error: /duplicate|unique/i.test(m) ? `${email} is already connected. Replace its App Password instead.` : 'Could not save the account.' }];
        }
        return [200, { id }];
      },
    },
    {
      method: 'POST', path: '/connectors/gmail/replace', auth: 'secret',
      handle: async (_req, raw) => {
        const b = parse(Replace, raw);
        if (typeof b === 'string') return [400, { error: b }];
        const pass = normalizeAppPassword(b.appPassword);
        if (!pass) return [400, { error: 'An App Password is 16 letters (4 groups of 4).' }];
        const kr = d.keyring();
        if (!kr) return noKey;
        const c = await d.store().get(b.id);
        if (!c || c.kind !== 'gmail' || !c.account_email) return [404, { error: 'Unknown Gmail account.' }];
        const t = await test(c.account_email, pass);
        if (!t.ok) return [400, { error: t.error }];
        await d.store().rotate(c.id, seal(pass, kr, connectorContext(c.id)));
        return [200, { ok: true }];
      },
    },
    {
      method: 'POST', path: '/connectors/test', auth: 'secret',
      handle: async (_req, raw) => {
        const b = parse(Test, raw);
        if (typeof b === 'string') return [400, { error: b }];
        const kr = d.keyring();
        if (!kr) return noKey;
        const c = await d.store().get(b.id);
        if (!c) return [404, { error: 'Unknown connector.' }];
        if (c.kind !== 'gmail' || !c.account_email || !c.sealed) return [400, { error: 'Testing this kind of connector is not supported yet.' }];
        let pass: string;
        try { pass = open(c.sealed, kr, connectorContext(c.id)); } catch { return [200, { ok: false, error: 'The stored App Password could not be decrypted. Replace it.' }]; }
        const t = await test(c.account_email, pass);
        await d.store().mark(c.id, t.ok ? 'active' : t.reauth ? 'needs_reauth' : 'error', t.ok ? null : t.error).catch(() => undefined);
        return [200, t.ok ? { ok: true } : { ok: false, error: t.error }];
      },
    },
  ];
}

let store: ConnectorStore | null = null;
export const connectorRoutes: Route[] = createConnectorRoutes({
  store: () => (store ??= createSupabaseConnectorStore(createServiceClient())),
  keyring: () => loadKeyring(workerEnv()),
});
