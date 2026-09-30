-- HQ Brain M14.2 (docs/16-BRAIN.md): OAuth 2.1 for the Brain MCP connector (https://hq.rizehub.ph/mcp/brain).
-- Claude (claude.ai, the desktop and phone apps, Claude Code) registers itself (RFC 7591 dynamic client registration),
-- the CEO approves it on /oauth/authorize after the HQ sign-in + 2FA, and the client gets a 1-hour access token plus a
-- rotating refresh token. Only hashes are stored (sha256 hex, computed by the brain service): a database dump can't be
-- replayed. A refresh token used twice revokes its whole family (token theft). The only writer is the brain service
-- (service role); the CEO lists and revokes connections through the CEO API below (M3 Devices & accounts).

create table brain_oauth_clients (
  client_id     text primary key check (client_id ~ '^hqbc_[A-Za-z0-9_-]{16,64}$'),
  client_name   text not null check (length(client_name) between 1 and 100),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  client_uri    text,
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create table brain_oauth_codes (
  code_hash      text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  client_id      text not null references brain_oauth_clients (client_id) on delete cascade,
  user_id        uuid not null,
  redirect_uri   text not null,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43,128}$'),
  scopes         text[] not null,
  resource       text,
  expires_at     timestamptz not null,
  used_at        timestamptz,
  created_at     timestamptz not null default now()
);

create table brain_tokens (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  kind         text not null check (kind in ('access', 'refresh')),
  family_id    uuid not null,                          -- one per approval; every refresh rotation stays in it
  client_id    text references brain_oauth_clients (client_id) on delete cascade,
  user_id      uuid,
  subject      text not null default 'ceo',            -- ceo | agent:<id> (M14.4 scoped agent tokens)
  scopes       text[] not null,
  resource     text,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index brain_tokens_family on brain_tokens (family_id);
create index brain_tokens_expiry on brain_tokens (expires_at);

do $$
declare t text;
begin
  foreach t in array array['brain_oauth_clients', 'brain_oauth_codes', 'brain_tokens'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

-- ---------- service (hq-brain) ----------

-- RFC 7591 registration. p: {client_id, client_name, redirect_uris[], client_uri?, meta?}. Returns the stored client.
-- The service validates redirect URIs against its allowlist before calling this; the cap stops registration floods.
create or replace function brain_oauth_register(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r brain_oauth_clients;
begin
  -- Registrations nobody ever approved expire after a day.
  delete from brain_oauth_clients c
   where c.created_at < now() - interval '1 day'
     and not exists (select 1 from brain_tokens t where t.client_id = c.client_id);
  if (select count(*) from brain_oauth_clients) >= 200 then
    raise exception 'too many registered clients' using errcode = '54000';
  end if;
  insert into brain_oauth_clients (client_id, client_name, redirect_uris, client_uri, meta)
  values (p->>'client_id', left(coalesce(nullif(trim(p->>'client_name'), ''), 'MCP client'), 100),
          array(select jsonb_array_elements_text(p->'redirect_uris')), nullif(p->>'client_uri', ''), coalesce(p->'meta', '{}'))
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function brain_oauth_client(p_client_id text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select to_jsonb(c) from brain_oauth_clients c where c.client_id = p_client_id;
$$;

-- p: {code_hash, client_id, user_id, redirect_uri, code_challenge, scopes[], resource?, ttl_seconds}
create or replace function brain_oauth_issue_code(p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from brain_oauth_codes where expires_at < now() - interval '1 hour';
  if not exists (select 1 from ceo_users where user_id = (p->>'user_id')::uuid) then
    raise exception 'not the CEO' using errcode = '42501';
  end if;
  insert into brain_oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
  values (p->>'code_hash', p->>'client_id', (p->>'user_id')::uuid, p->>'redirect_uri', p->>'code_challenge',
          array(select jsonb_array_elements_text(p->'scopes')), nullif(p->>'resource', ''),
          now() + make_interval(secs => greatest(30, least(coalesce((p->>'ttl_seconds')::int, 300), 600))));
end $$;

-- One-time use: returns the code (and marks it used) only when it is unused, unexpired and belongs to this client.
-- A second use of the same code revokes every token it produced (RFC 6749 §4.1.2).
create or replace function brain_oauth_redeem_code(p_code_hash text, p_client_id text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r brain_oauth_codes;
begin
  update brain_oauth_codes set used_at = now()
   where code_hash = p_code_hash and client_id = p_client_id and used_at is null and expires_at > now()
  returning * into r;
  if r.code_hash is null then
    update brain_tokens set revoked_at = now()
     where revoked_at is null and family_id = (select md5(code_hash)::uuid from brain_oauth_codes
                                                where code_hash = p_code_hash and used_at is not null);
    return null;
  end if;
  return to_jsonb(r) || jsonb_build_object('family_id', md5(r.code_hash)::uuid);
end $$;

-- p: {family_id, client_id?, user_id?, subject?, scopes[], resource?,
--     access: {hash, ttl_seconds}, refresh?: {hash, ttl_seconds}}. Inserts the pair.
create or replace function brain_token_issue(p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare sc text[] := array(select jsonb_array_elements_text(p->'scopes'));
begin
  delete from brain_tokens where expires_at < now() - interval '7 days';
  insert into brain_tokens (token_hash, kind, family_id, client_id, user_id, subject, scopes, resource, expires_at)
  values (p->'access'->>'hash', 'access', (p->>'family_id')::uuid, nullif(p->>'client_id', ''), nullif(p->>'user_id', '')::uuid,
          coalesce(nullif(p->>'subject', ''), 'ceo'), sc, nullif(p->>'resource', ''),
          now() + make_interval(secs => (p->'access'->>'ttl_seconds')::int));
  if p ? 'refresh' then
    insert into brain_tokens (token_hash, kind, family_id, client_id, user_id, subject, scopes, resource, expires_at)
    values (p->'refresh'->>'hash', 'refresh', (p->>'family_id')::uuid, nullif(p->>'client_id', ''), nullif(p->>'user_id', '')::uuid,
            coalesce(nullif(p->>'subject', ''), 'ceo'), sc, nullif(p->>'resource', ''),
            now() + make_interval(secs => (p->'refresh'->>'ttl_seconds')::int));
  end if;
  if p->>'client_id' is not null then
    update brain_oauth_clients set last_used_at = now() where client_id = p->>'client_id';
  end if;
end $$;

-- Access token → who is calling, or null (unknown, expired, revoked, or a CEO token whose user is no longer the CEO).
create or replace function brain_token_check(p_hash text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r brain_tokens;
begin
  select * into r from brain_tokens
   where token_hash = p_hash and kind = 'access' and revoked_at is null and expires_at > now();
  if r.id is null then return null; end if;
  if r.subject = 'ceo' and not exists (select 1 from ceo_users where user_id = r.user_id) then return null; end if;
  if r.last_used_at is null or r.last_used_at < now() - interval '1 minute' then
    update brain_tokens set last_used_at = now() where id = r.id;
  end if;
  return jsonb_build_object('token_id', r.id, 'family_id', r.family_id, 'client_id', r.client_id, 'user_id', r.user_id,
                            'subject', r.subject, 'scopes', to_jsonb(r.scopes), 'resource', r.resource,
                            'client_name', (select client_name from brain_oauth_clients where client_id = r.client_id));
end $$;

-- Refresh-token rotation. Valid → the old refresh token is revoked and its family returned (the caller issues the new
-- pair with brain_token_issue). Already used or revoked → the whole family is revoked (someone replayed it). Null = refused.
create or replace function brain_token_refresh(p_hash text, p_client_id text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r brain_tokens;
begin
  select * into r from brain_tokens where token_hash = p_hash and kind = 'refresh' and client_id = p_client_id for update;
  if r.id is null then return null; end if;
  if r.revoked_at is not null then
    update brain_tokens set revoked_at = now() where family_id = r.family_id and revoked_at is null;
    return null;
  end if;
  if r.expires_at <= now() then return null; end if;
  if r.subject = 'ceo' and not exists (select 1 from ceo_users where user_id = r.user_id) then return null; end if;
  update brain_tokens set revoked_at = now() where id = r.id;
  -- Access tokens issued before this rotation stop working as well: only the newest pair is live.
  update brain_tokens set revoked_at = now() where family_id = r.family_id and kind = 'access' and revoked_at is null;
  return jsonb_build_object('family_id', r.family_id, 'client_id', r.client_id, 'user_id', r.user_id, 'subject', r.subject,
                            'scopes', to_jsonb(r.scopes), 'resource', r.resource);
end $$;

-- RFC 7009: revoking either token of a pair ends the whole connection (family). Unknown tokens are not an error.
create or replace function brain_token_revoke(p_hash text, p_client_id text) returns int
language sql security definer set search_path = public, extensions as $$
  with f as (select family_id from brain_tokens where token_hash = p_hash and (p_client_id is null or client_id = p_client_id)),
       u as (update brain_tokens set revoked_at = now() where family_id in (select family_id from f) and revoked_at is null returning 1)
  select count(*)::int from u;
$$;

-- ---------- CEO API (M3 Devices & accounts) ----------

-- One row per live connection (approval): client, scopes, when it was approved and last used.
create or replace function brain_connections() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform hq_guard();
  return coalesce((
    select jsonb_agg(x order by x.last_used_at desc nulls last)
      from (select t.family_id, t.client_id, c.client_name, c.redirect_uris, t.subject, t.scopes,
                   min(t.created_at) as approved_at, max(t.last_used_at) as last_used_at, max(t.expires_at) as expires_at
              from brain_tokens t left join brain_oauth_clients c on c.client_id = t.client_id
             where t.revoked_at is null and t.expires_at > now()
             group by t.family_id, t.client_id, c.client_name, c.redirect_uris, t.subject, t.scopes) x), '[]'::jsonb);
end $$;

create or replace function brain_revoke_connection(p_family_id uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  perform hq_guard();
  update brain_tokens set revoked_at = now() where family_id = p_family_id and revoked_at is null;
  get diagnostics n = row_count;
  insert into brain_events (actor, action, summary, meta)
  values ('julev', 'revoked', 'connector access revoked', jsonb_build_object('family_id', p_family_id));
  return n;
end $$;

-- ---------- grants ----------
do $$
declare f text;
begin
  foreach f in array array['brain_connections()', 'brain_revoke_connection(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array['brain_oauth_register(jsonb)', 'brain_oauth_client(text)', 'brain_oauth_issue_code(jsonb)',
                           'brain_oauth_redeem_code(text, text)', 'brain_token_issue(jsonb)', 'brain_token_check(text)',
                           'brain_token_refresh(text, text)', 'brain_token_revoke(text, text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
