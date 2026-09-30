// Local store: an in-process Postgres (PGlite + pgvector) running the REAL migrations, so `pnpm dev:brain` and the tests
// exercise the same SQL as production. Same Supabase shim as scripts/db-test.mjs. No JWT = a direct DB session, which
// hq_can_operate() allows (like migrations and tests).
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { Store } from './types';

const SHIM = `
create role authenticated nologin; create role anon nologin; create role service_role nologin bypassrls;
create schema auth; create schema extensions;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
grant usage on schema auth to authenticated, anon, service_role;
grant execute on all functions in schema auth to authenticated, anon, service_role;
create publication supabase_realtime;
alter default privileges in schema public grant all on tables to authenticated, anon, service_role;
alter default privileges in schema public grant all on sequences to authenticated, anon, service_role;
grant usage on schema public to authenticated, anon, service_role;
`;

const IDENT = /^[a-z_][a-z0-9_]*$/;

export async function createPgliteStore(migrationsDir: string): Promise<Store> {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(SHIM);
  for (const f of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  return {
    async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      const keys = Object.keys(args);
      if (!IDENT.test(fn) || !keys.every((k) => IDENT.test(k))) throw new Error(`bad rpc name: ${fn}`);
      const values = keys.map((k) => {
        const v = args[k];
        return v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : v;
      });
      const sql = `select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
      try {
        const res = await db.query<{ r: T }>(sql, values);
        return res.rows[0]?.r as T;
      } catch (e) {
        throw new Error(`${fn}: ${(e as Error).message}`);
      }
    },
    close: () => db.close(),
  };
}

/** supabase/migrations, found from this file (apps/brain/src/store → repo root). */
export const defaultMigrationsDir = () => path.resolve(import.meta.dirname, '../../../../supabase/migrations');
