// Admin → API & AI (docs/14 "Dashboard settings"): the dashboard server stores, tests and reloads provider keys and
// reads what the worker runs with. x-hq-secret like every dashboard → worker call; the CEO check and the 2FA step-up
// happen in the dashboard before it calls here. A key is checked against the allowlist (bootstrap secrets are refused),
// optionally tested live, sealed with the vault keyring and stored; it is never logged or returned (only its last 4).
import { z } from 'zod';
import {
  ANTHROPIC_WORKSPACE_ID, BOOTSTRAP_SECRET, isProviderKeyName, PROVIDER_KEY_NAMES, PROVIDER_KEY_VALUE, providerKeyContext,
} from '@rizehubhq/shared';
import type { Route } from './types';
import { baseEnvValue, providerKeyOverlayNames, workerEnv } from '../config';
import { seal, type Keyring } from '../vault/crypto';
import type { ProviderKeyStore } from '../settings/store';
import type { RuntimeSnapshot } from '../settings/runtime';
import { createKeyTester, redact, type KeyTester } from '../settings/keyTest';

export type KeySource = 'dashboard' | 'env' | 'missing';

export interface KeyEnvView {
  /** The value agents use now (dashboard overlay over .env). */
  value(name: string): string | undefined;
  source(name: string): KeySource;
  /** The server's .env has a value too (shown as "also in .env" when the dashboard one overrides it). */
  inEnv?(name: string): boolean;
}

export const liveKeyEnv: KeyEnvView = {
  value: (name) => workerEnv()[name] || undefined,
  source: (name) => (providerKeyOverlayNames().includes(name) ? 'dashboard' : baseEnvValue(name) ? 'env' : 'missing'),
  inEnv: (name) => !!baseEnvValue(name),
};

export interface SettingsRouteDeps {
  store: () => ProviderKeyStore;
  keyring: () => Keyring | null;
  /** The worker's RuntimeSettings (null until index.ts wires it: routes then answer 503). */
  runtime: () => { refresh(): Promise<RuntimeSnapshot>; snapshot: RuntimeSnapshot | null } | null;
  test?: KeyTester;
  env?: KeyEnvView;
  /** Effective AI settings + the model each role gets now (index.ts; optional). */
  aiStatus?: () => Record<string, unknown>;
  log?: (m: string) => void;
}

const SetKey = z.object({ name: z.string().max(80), value: z.string().max(1024), test: z.boolean().optional() });
const NameOnly = z.object({ name: z.string().max(80) });

function parse<S extends z.ZodTypeAny>(schema: S, raw: Buffer): z.output<S> | string {
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return 'invalid JSON'; }
  const r = schema.safeParse(body);
  return r.success ? (r.data as z.output<S>) : (r.error.issues[0]?.message ?? 'invalid input');
}

/** null when the name may be managed from the dashboard, else the reason (bootstrap secrets get a clear refusal). */
export function keyNameProblem(name: string): string | null {
  if (isProviderKeyName(name)) return null;
  if (BOOTSTRAP_SECRET.test(name)) return `${name} is a system secret: it stays in the server's .env and can't be stored from the dashboard.`;
  return 'Unknown key name.';
}

export function createSettingsRoutes(d: SettingsRouteDeps): Route[] {
  const tester = d.test ?? createKeyTester();
  const env = d.env ?? liveKeyEnv;
  const log = d.log ?? ((m: string) => console.log(m));
  const notReady: [number, unknown] = [503, { error: 'The worker is still starting. Try again in a moment.' }];

  const refresh = async () => {
    const rt = d.runtime();
    if (!rt) return null;
    return rt.refresh();
  };

  return [
    {
      method: 'POST', path: '/settings/keys/set', auth: 'secret',
      handle: async (_req, raw) => {
        const b = parse(SetKey, raw);
        if (typeof b === 'string') return [400, { error: b }];
        const problem = keyNameProblem(b.name);
        if (problem) return [400, { error: problem }];
        const value = b.value.trim();
        if (!PROVIDER_KEY_VALUE.test(value)) return [400, { error: 'That doesn\'t look like an API key (8 to 512 characters, no spaces).' }];
        if (b.name === 'ANTHROPIC_WORKSPACE_ID' && !ANTHROPIC_WORKSPACE_ID.test(value)) {
          return [400, { error: 'An Anthropic workspace ID looks like wrkspc_01Jw… (Console → Settings → Workspaces).' }];
        }
        const kr = d.keyring();
        if (!kr) return [503, { error: 'The worker cannot encrypt keys: VAULT_MASTER_KEY is not set.' }];
        const t = b.test === false ? null : await tester(b.name, value);
        if (t && t.ok === false) return [400, { error: redact(t.error, value) }];
        try {
          await d.store().upsert(b.name, seal(value, kr, providerKeyContext(b.name)), value.slice(-4), t && t.ok !== null ? { ok: t.ok } : null);
        } catch (e) {
          log(`[settings] saving ${b.name} failed: ${redact(e instanceof Error ? e.message : String(e), value).slice(0, 200)}`);
          return [500, { error: 'Could not save the key.' }];
        }
        let applied = true;
        await refresh().catch((e) => { applied = false; log(`[settings] reload after saving ${b.name} failed: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}`); });
        log(`[settings] ${b.name} stored from the dashboard${t ? (t.ok ? ' (tested)' : ' (not testable)') : ' (not tested)'}`);
        return [200, {
          ok: true, last4: value.slice(-4), tested: t ? t.ok : null, applied,
          message: t ? t.message : 'Saved without a test.',
        }];
      },
    },
    {
      method: 'POST', path: '/settings/keys/test', auth: 'secret',
      handle: async (_req, raw) => {
        const b = parse(NameOnly, raw);
        if (typeof b === 'string') return [400, { error: b }];
        const problem = keyNameProblem(b.name);
        if (problem) return [400, { error: problem }];
        const source = env.source(b.name);
        const value = env.value(b.name);
        if (!value || source === 'missing') return [200, { ok: false, source: 'missing', error: 'No key is set for this service.' }];
        const t = await tester(b.name, value);
        const error = t.ok === false ? redact(t.error, value) : null;
        if (source === 'dashboard' && t.ok !== null) await d.store().markTest(b.name, t.ok, error).catch(() => undefined);
        return [200, t.ok === false ? { ok: false, source, error } : { ok: t.ok, source, message: t.message }];
      },
    },
    {
      method: 'POST', path: '/settings/reload', auth: 'secret',
      handle: async () => {
        if (!d.runtime()) return notReady;
        try {
          const s = await refresh();
          return [200, { ok: true, keys: s?.keys ?? [], unreadable: s?.unreadable ?? [] }];
        } catch (e) {
          return [500, { error: `Could not re-read the settings: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}` }];
        }
      },
    },
    {
      method: 'POST', path: '/settings/status', auth: 'secret',
      handle: async () => {
        const snap = d.runtime()?.snapshot ?? null;
        return [200, {
          keys: PROVIDER_KEY_NAMES.map((name) => ({ name, source: env.source(name) })),
          envAlso: PROVIDER_KEY_NAMES.filter((name) => env.inEnv?.(name) ?? false),
          unreadable: snap?.unreadable ?? [],
          loadedAt: snap ? new Date(snap.loadedAt).toISOString() : null,
          ...(d.aiStatus?.() ?? {}),
        }];
      },
    },
  ];
}
