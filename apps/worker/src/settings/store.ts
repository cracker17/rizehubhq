// The worker's door to provider_keys + the AI settings rows (supabase/migrations/20260929070000_provider_keys.sql).
// Ciphertext only moves through the service-role functions; values are decrypted in settings/runtime.ts.
import type { SupabaseClient } from '@supabase/supabase-js';
import { fromPgBytea, toPgBytea, type Sealed } from '../vault/crypto';

export interface SealedKeyRow { name: string; sealed: Sealed }

export interface ProviderKeyStore {
  /** Every stored key, sealed. */
  sealed(): Promise<SealedKeyRow[]>;
  /** Every settings row (key → jsonb value): the ai_* rows and the older daily_budget_usd. */
  settings(): Promise<Record<string, unknown>>;
  upsert(name: string, sealed: Sealed, last4: string, test: { ok: boolean; error?: string | null } | null): Promise<void>;
  markTest(name: string, ok: boolean, error?: string | null): Promise<void>;
}

export function createSupabaseProviderKeyStore(db: SupabaseClient): ProviderKeyStore {
  const rpc = async <T>(fn: string, args: Record<string, unknown> = {}): Promise<T> => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };
  return {
    sealed: async () => ((await rpc<{ name: string; cipher: string; iv: string; key_version: number }[]>('provider_keys_sealed')) ?? [])
      .map((r) => ({ name: r.name, sealed: { cipher: fromPgBytea(r.cipher), iv: fromPgBytea(r.iv), keyVersion: Number(r.key_version) } })),
    settings: async () => {
      const { data, error } = await db.from('settings').select('key,value');
      if (error) throw new Error(`settings: ${error.message}`);
      return Object.fromEntries(((data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    },
    upsert: async (name, s, last4, test) => {
      await rpc('provider_key_upsert', {
        p_name: name, p_cipher: toPgBytea(s.cipher), p_iv: toPgBytea(s.iv), p_key_version: s.keyVersion, p_last4: last4,
        p_test_ok: test ? test.ok : null, p_error: test && !test.ok ? (test.error ?? null) : null,
      });
    },
    markTest: async (name, ok, error = null) => { await rpc('provider_key_mark_test', { p_name: name, p_ok: ok, p_error: error }); },
  };
}

/** In-memory store for tests (no crypto shortcuts: rows hold real sealed values). */
export class FakeProviderKeyStore implements ProviderKeyStore {
  rows = new Map<string, { sealed: Sealed; last4: string; test: { ok: boolean; error?: string | null } | null }>();
  settingsRows: Record<string, unknown> = {};
  failReads = false;
  async sealed() {
    if (this.failReads) throw new Error('db down');
    return [...this.rows].map(([name, r]) => ({ name, sealed: r.sealed }));
  }
  async settings() {
    if (this.failReads) throw new Error('db down');
    return { ...this.settingsRows };
  }
  async upsert(name: string, sealed: Sealed, last4: string, test: { ok: boolean; error?: string | null } | null) { this.rows.set(name, { sealed, last4, test }); }
  async markTest(name: string, ok: boolean, error: string | null = null) {
    const r = this.rows.get(name);
    if (r) r.test = { ok, error };
  }
}
