-- Supabase-like roles + auth schema for the integration test (PostgREST edition of the PGlite stubs in
-- scripts/db-test.mjs). Mirrors what the Supabase image provides before migrations run:
--   authenticator (PostgREST login) → switches to anon / authenticated / service_role per JWT `role`.
--   auth.uid() / auth.role() / auth.jwt() read PostgREST's request.jwt.claims GUC (same bodies as Supabase).
create role authenticator login noinherit password 'authenticator';
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
grant anon, authenticated, service_role to authenticator;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  role text default 'authenticated',
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create publication supabase_realtime;

-- Supabase's default privileges on public (RLS + explicit revokes in the migrations do the rest).
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
