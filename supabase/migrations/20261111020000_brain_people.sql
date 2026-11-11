-- HQ Brain P2: people + per-project access (vault projects/hq-brain/onboarding-and-access-plan.md §1–3, §7 decisions
-- answered 2026-11-11). Deny by default: a person sees only projects granted to them, never the owner-only areas.
--   Roles: admin (everything except owner-only areas, can't manage people), member (granted projects, read or edit),
--          viewer (granted projects, read only). The owner (CEO, ceo_users) is not a row here and sees everything.
--   Members reach the brain through the Claude connector (P2: "Claude-only first"); their tokens have subject 'person'
--   and every MCP tool filters by brain_person_access(). Edits save straight away, committed as user:<email>.
--   Raw "-code-" transcripts stay hidden unless a grant switches them on.

create table brain_people (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references auth.users (id) on delete set null,   -- set when they join
  email         text not null unique check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name          text not null check (char_length(name) between 1 and 80),
  title         text,
  role          text not null default 'member' check (role in ('admin', 'member', 'viewer')),
  invite_hash   text unique,
  invite_expires_at timestamptz,
  invited_at    timestamptz not null default now(),
  joined_at     timestamptz,
  disabled_at   timestamptz,
  updated_at    timestamptz not null default now()
);

create table brain_project_grants (
  person_id     uuid not null references brain_people (id) on delete cascade,
  project_slug  text not null check (project_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  access        text not null default 'read' check (access in ('read', 'write')),
  transcripts   boolean not null default false,
  expires_at    date,
  granted_at    timestamptz not null default now(),
  primary key (person_id, project_slug)
);

alter table brain_people enable row level security;
alter table brain_project_grants enable row level security;
create policy ceo_read on brain_people for select to authenticated using (is_ceo());
create policy ceo_read on brain_project_grants for select to authenticated using (is_ceo());
revoke all on brain_people, brain_project_grants from anon, authenticated;
grant select (id, user_id, email, name, title, role, invite_expires_at, invited_at, joined_at, disabled_at, updated_at) on brain_people to authenticated;
grant select on brain_project_grants to authenticated;
grant select, insert, update, delete on brain_people, brain_project_grants to service_role;

-- ---------- visibility ----------

-- Owner-only areas: never shown to anyone but the CEO (profile, guides, scheduled tasks with client e-mails, the secrets
-- index, rules, projects.json, the cross-project session log, device notes, secrets maps).
create or replace function brain_owner_only(p_path text) returns boolean
language sql immutable set search_path = public, extensions as $$
  select p_path ~ '^(profile|docs|scheduled-tasks|skills|claude-commands|devices|scripts)/'
      or p_path in ('env-index.md', 'CLAUDE.md', 'projects.json', 'LOG.md', 'README.md')
      or p_path ~ '(^|/)secrets-map\.md$';
$$;

-- Everything the connector needs to filter for one HQ user, or null if they are not an active person.
-- {person_id, role, email, name, grants: [{slug, access, transcripts}]} — expired grants are left out.
create or replace function brain_person_access(p_user uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('person_id', p.id, 'role', p.role, 'email', p.email, 'name', p.name,
    'grants', coalesce((select jsonb_agg(jsonb_build_object('slug', g.project_slug,
                          'access', case when p.role = 'viewer' then 'read' else g.access end, 'transcripts', g.transcripts) order by g.project_slug)
                          from brain_project_grants g
                         where g.person_id = p.id and (g.expires_at is null or g.expires_at >= current_date)), '[]'::jsonb))
    from brain_people p
   where p.user_id = p_user and p.disabled_at is null and p.joined_at is not null;
$$;

-- ---------- CEO API (People screens) ----------

create or replace function brain_people_list() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform hq_guard();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'email', p.email, 'name', p.name, 'title', p.title, 'role', p.role,
      'invited_at', p.invited_at, 'invite_expires_at', p.invite_expires_at, 'joined_at', p.joined_at, 'disabled_at', p.disabled_at,
      'grants', coalesce((select jsonb_agg(jsonb_build_object('slug', g.project_slug, 'access', g.access, 'transcripts', g.transcripts, 'expires_at', g.expires_at) order by g.project_slug)
                            from brain_project_grants g where g.person_id = p.id), '[]'::jsonb),
      'last_active_at', (select max(t.last_used_at) from brain_tokens t where t.user_id = p.user_id and t.subject = 'person'),
      'connections', (select count(distinct t.family_id) from brain_tokens t where t.user_id = p.user_id and t.subject = 'person' and t.revoked_at is null and t.expires_at > now())
    ) order by p.disabled_at nulls first, p.name) from brain_people p), '[]'::jsonb);
end $$;

-- Invite (or re-invite): returns the one-time join code once (7 days). p: {email, name, title?, role, grants: [...]}
create or replace function brain_person_invite(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code text := replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_id uuid;
begin
  perform hq_guard();
  insert into brain_people (email, name, title, role, invite_hash, invite_expires_at)
  values (lower(btrim(p->>'email')), left(btrim(p->>'name'), 80), nullif(left(btrim(coalesce(p->>'title', '')), 80), ''),
          coalesce(p->>'role', 'member'), encode(sha256(convert_to(v_code, 'utf8')), 'hex'), now() + interval '7 days')
  on conflict (email) do update set name = excluded.name, title = excluded.title, role = excluded.role,
    invite_hash = case when brain_people.joined_at is null then excluded.invite_hash else brain_people.invite_hash end,
    invite_expires_at = case when brain_people.joined_at is null then excluded.invite_expires_at else brain_people.invite_expires_at end,
    disabled_at = null, updated_at = now()
  returning id into v_id;
  perform brain_set_grants(v_id, coalesce(p->'grants', '[]'::jsonb));
  perform brain_log_event('julev', 'person_invited', null, null, left(btrim(p->>'name'), 80), jsonb_build_object('person', v_id, 'role', p->>'role'));
  return jsonb_build_object('id', v_id,
    'code', case when (select joined_at from brain_people where id = v_id) is null then v_code end);
end $$;

-- Replace a person's grants. grants: [{slug, access, transcripts, expires_at}]
create or replace function brain_set_grants(p_person uuid, p_grants jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  perform hq_guard();
  delete from brain_project_grants where person_id = p_person;
  insert into brain_project_grants (person_id, project_slug, access, transcripts, expires_at)
  select p_person, g->>'slug', case when g->>'access' = 'write' then 'write' else 'read' end,
         coalesce((g->>'transcripts')::boolean, false), nullif(g->>'expires_at', '')::date
    from jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) g
   where g->>'slug' ~ '^[a-z0-9][a-z0-9-]{0,63}$' and coalesce(g->>'access', 'read') <> 'none'
  on conflict do nothing;
  get diagnostics n = row_count;
  update brain_people set updated_at = now() where id = p_person;
  return n;
end $$;

-- Save role + grants from the person screen.
create or replace function brain_person_update(p_person uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform hq_guard();
  update brain_people set role = coalesce(p->>'role', role), title = case when p ? 'title' then nullif(left(btrim(p->>'title'), 80), '') else title end,
         updated_at = now() where id = p_person;
  if p ? 'grants' then perform brain_set_grants(p_person, p->'grants'); end if;
  perform brain_log_event('julev', 'access_changed', null, null, (select name from brain_people where id = p_person), jsonb_build_object('person', p_person));
end $$;

-- Disable: their connector tokens stop at once (brain_token_check), the invite stops working.
create or replace function brain_person_disable(p_person uuid, p_disabled boolean default true) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform hq_guard();
  update brain_people set disabled_at = case when p_disabled then now() end, invite_hash = case when p_disabled then null else invite_hash end,
         updated_at = now() where id = p_person;
  if p_disabled then
    update brain_tokens set revoked_at = now()
     where revoked_at is null and subject = 'person' and user_id = (select user_id from brain_people where id = p_person);
  end if;
end $$;

-- ---------- join (public /join/<code> → brain service, which creates the auth user) ----------

-- The invite behind a join code, for the join page (no secrets): {id, email, name, role, projects: n} or null.
create or replace function brain_invite_peek(p_code_hash text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('id', p.id, 'email', p.email, 'name', p.name, 'role', p.role,
                            'projects', (select count(*) from brain_project_grants g where g.person_id = p.id))
    from brain_people p
   where p.invite_hash = p_code_hash and p.invite_expires_at > now() and p.joined_at is null and p.disabled_at is null;
$$;

-- Link the new auth user to the invite (single use).
create or replace function brain_invite_accept(p_code_hash text, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  update brain_people set user_id = p_user, joined_at = now(), invite_hash = null, updated_at = now()
   where invite_hash = p_code_hash and invite_expires_at > now() and joined_at is null and disabled_at is null
  returning id into v_id;
  if v_id is null then return null; end if;
  perform brain_log_event('person', 'person_joined', null, null, (select name from brain_people where id = v_id), jsonb_build_object('person', v_id));
  return jsonb_build_object('id', v_id);
end $$;

-- A signed-in person's own view (member home page): what they can see. Null for anyone else.
create or replace function brain_my_access() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select brain_person_access(auth.uid()) || jsonb_build_object(
    'projects', coalesce((select jsonb_agg(jsonb_build_object('slug', g->>'slug', 'access', g->>'access', 'name', coalesce(pr.name, g->>'slug')))
                            from jsonb_array_elements(brain_person_access(auth.uid())->'grants') g
                            left join brain_projects pr on pr.slug = g->>'slug'), '[]'::jsonb))
   where brain_person_access(auth.uid()) is not null;
$$;

-- ---------- connector OAuth: people as well as the CEO ----------

create or replace function brain_oauth_issue_code(p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user uuid := (p->>'user_id')::uuid;
  v_person jsonb := brain_person_access(v_user);
  v_scopes text[] := array(select jsonb_array_elements_text(p->'scopes'));
begin
  delete from brain_oauth_codes where expires_at < now() - interval '1 hour';
  if not exists (select 1 from ceo_users where user_id = v_user) then
    if v_person is null then raise exception 'not the CEO or an invited person' using errcode = '42501'; end if;
    if v_person->>'role' = 'viewer' then v_scopes := array['brain:read']; end if; -- viewers never get write
  end if;
  insert into brain_oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
  values (p->>'code_hash', p->>'client_id', v_user, p->>'redirect_uri', p->>'code_challenge', v_scopes, nullif(p->>'resource', ''),
          now() + make_interval(secs => greatest(30, least(coalesce((p->>'ttl_seconds')::int, 300), 600))));
end $$;

-- The redeemed code now also says who it is for: subject 'ceo' or 'person'.
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
  return to_jsonb(r) || jsonb_build_object('family_id', md5(r.code_hash)::uuid,
    'subject', case when exists (select 1 from ceo_users where user_id = r.user_id) then 'ceo' else 'person' end);
end $$;

-- Token check: a person's token dies the moment they are disabled (or their join is undone).
create or replace function brain_token_check(p_hash text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r brain_tokens;
begin
  select * into r from brain_tokens
   where token_hash = p_hash and kind = 'access' and revoked_at is null and expires_at > now();
  if r.id is null then return null; end if;
  if r.subject = 'ceo' and not exists (select 1 from ceo_users where user_id = r.user_id) then return null; end if;
  if r.subject = 'person' and brain_person_access(r.user_id) is null then return null; end if;
  if r.last_used_at is null or r.last_used_at < now() - interval '1 minute' then
    update brain_tokens set last_used_at = now() where id = r.id;
  end if;
  return jsonb_build_object('token_id', r.id, 'family_id', r.family_id, 'client_id', r.client_id, 'user_id', r.user_id,
                            'subject', r.subject, 'scopes', to_jsonb(r.scopes), 'resource', r.resource,
                            'client_name', (select client_name from brain_oauth_clients where client_id = r.client_id));
end $$;

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
  if r.subject = 'person' and brain_person_access(r.user_id) is null then return null; end if;
  update brain_tokens set revoked_at = now() where id = r.id;
  update brain_tokens set revoked_at = now() where family_id = r.family_id and kind = 'access' and revoked_at is null;
  return jsonb_build_object('family_id', r.family_id, 'client_id', r.client_id, 'user_id', r.user_id, 'subject', r.subject,
                            'scopes', to_jsonb(r.scopes), 'resource', r.resource);
end $$;

-- ---------- grants ----------
do $$
declare f text;
begin
  foreach f in array array['brain_people_list()', 'brain_person_invite(jsonb)', 'brain_set_grants(uuid, jsonb)',
                           'brain_person_update(uuid, jsonb)', 'brain_person_disable(uuid, boolean)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array['brain_person_access(uuid)', 'brain_invite_peek(text)', 'brain_invite_accept(text, uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  execute 'revoke execute on function brain_owner_only(text) from public, anon';
  execute 'grant execute on function brain_owner_only(text) to authenticated, service_role';
  execute 'revoke execute on function brain_my_access() from public, anon';
  execute 'grant execute on function brain_my_access() to authenticated, service_role';
end $$;
