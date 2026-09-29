-- M13 Connectors (docs/15): outside services the agents may use, chosen by the CEO in Admin → Connectors.
-- This step: the shared tables and Gmail accounts (App Password over IMAP/SMTP). MCP servers (kind 'mcp') reuse them.
-- Secrets follow the Client Vault pattern (20260928040000_client_vault.sql): sealed by the worker with the vault
-- keyring (context 'connector:<id>'), stored as ciphertext, never readable by the browser, never logged.

create table connectors (
  id              uuid primary key,                 -- chosen by the worker: part of the encryption context
  kind            text not null check (kind in ('gmail', 'mcp')),
  catalog_key     text,                             -- 'gmail', 'notion', … (null = custom)
  name            text not null,
  account_email   text,
  url             text,
  auth_type       text not null check (auth_type in ('app_password', 'oauth', 'bearer', 'header', 'none')),
  settings        jsonb not null default '{}',      -- gmail: {"mode": "read" | "read_draft" | "read_draft_send"}
  status          text not null default 'active' check (status in ('active', 'needs_reauth', 'error', 'disabled')),
  last_checked_at timestamptz,
  last_used_at    timestamptz,
  last_error      text,
  secret_cipher   bytea,
  secret_iv       bytea,
  key_version     int,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index connectors_gmail_email on connectors (lower(account_email)) where kind = 'gmail';
create trigger t_connectors_touch before update on connectors for each row execute function touch_updated_at();

create table connector_grants (
  connector_id uuid not null references connectors(id) on delete cascade,
  agent_id     text not null references agents(id) on delete cascade,
  primary key (connector_id, agent_id)
);

alter table connectors enable row level security;
alter table connector_grants enable row level security;
create policy ceo_all on connectors for all to authenticated using (is_ceo()) with check (is_ceo());
create policy ceo_all on connector_grants for all to authenticated using (is_ceo()) with check (is_ceo());

-- The dashboard reads metadata only; every change goes through the functions below (audited, step-up where it loosens).
revoke select on connectors from authenticated, anon;
grant select (id, kind, catalog_key, name, account_email, url, auth_type, settings, status, last_checked_at, last_used_at,
              last_error, created_at, updated_at) on connectors to authenticated;
revoke insert, update, delete on connectors from authenticated, anon;
revoke insert, update, delete on connector_grants from authenticated, anon;

alter publication supabase_realtime add table connectors, connector_grants;

create or replace function connector_mode_ok(p_kind text, p_settings jsonb) returns boolean
language sql immutable set search_path = public as $$
  select p_kind <> 'gmail' or coalesce(p_settings ->> 'mode', 'read') in ('read', 'read_draft', 'read_draft_send');
$$;

-- Gmail permission levels, lowest first: read < read_draft < read_draft_send (each email still needs the CEO's approval).
create or replace function connector_mode_rank(p_settings jsonb) returns int
language sql immutable set search_path = public as $$
  select case coalesce(p_settings ->> 'mode', 'read') when 'read_draft_send' then 2 when 'read_draft' then 1 else 0 end;
$$;

-- ---------- worker only (ciphertext) ----------
create or replace function connector_insert(
  p_id uuid, p_kind text, p_name text, p_account_email text, p_url text, p_auth_type text, p_settings jsonb,
  p_cipher bytea, p_iv bytea, p_key_version int, p_grants text[] default '{}', p_catalog_key text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare g text;
begin
  perform vault_service_guard();
  if not connector_mode_ok(p_kind, p_settings) then raise exception 'connector_insert: bad mode' using errcode = '22023'; end if;
  insert into connectors (id, kind, catalog_key, name, account_email, url, auth_type, settings, secret_cipher, secret_iv,
                          key_version, last_checked_at)
  values (p_id, p_kind, p_catalog_key, left(p_name, 120), lower(p_account_email), p_url, p_auth_type, coalesce(p_settings, '{}'),
          p_cipher, p_iv, p_key_version, now());
  foreach g in array coalesce(p_grants, '{}') loop
    insert into connector_grants (connector_id, agent_id) select p_id, g where exists (select 1 from agents where id = g)
    on conflict do nothing;
  end loop;
  perform hq_log('ceo', 'connector.added', null, null, jsonb_build_object('connector_id', p_id, 'kind', p_kind, 'name', p_name,
                 'agents', coalesce(p_grants, '{}'), 'settings', coalesce(p_settings, '{}')));
  return p_id;
end $$;

create or replace function connector_rotate_secret(p_id uuid, p_cipher bytea, p_iv bytea, p_key_version int)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform vault_service_guard();
  update connectors set secret_cipher = p_cipher, secret_iv = p_iv, key_version = p_key_version, status = 'active',
                        last_error = null, last_checked_at = now()
  where id = p_id;
  if not found then raise exception 'connector_rotate_secret: unknown connector' using errcode = 'P0002'; end if;
  perform hq_log('ceo', 'connector.secret_replaced', null, null, jsonb_build_object('connector_id', p_id));
end $$;

-- Active connectors of one kind granted to an agent, with the sealed secret (decrypted only inside the worker).
create or replace function connectors_for_agent(p_agent text, p_kind text)
returns table (id uuid, name text, account_email text, url text, auth_type text, settings jsonb,
               secret_cipher bytea, secret_iv bytea, key_version int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform vault_service_guard();
  return query
    select c.id, c.name, c.account_email, c.url, c.auth_type, c.settings, c.secret_cipher, c.secret_iv, c.key_version
    from connectors c join connector_grants g on g.connector_id = c.id
    where g.agent_id = p_agent and c.kind = p_kind and c.status = 'active'
    order by c.created_at;
end $$;

create or replace function connector_get_sealed(p_id uuid)
returns table (id uuid, kind text, name text, account_email text, url text, auth_type text, settings jsonb, status text,
               secret_cipher bytea, secret_iv bytea, key_version int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform vault_service_guard();
  return query select c.id, c.kind, c.name, c.account_email, c.url, c.auth_type, c.settings, c.status,
                      c.secret_cipher, c.secret_iv, c.key_version
               from connectors c where c.id = p_id;
end $$;

-- After a test or a use: 'active' clears the error; 'error' / 'needs_reauth' keep a short reason for the CEO.
create or replace function connector_mark(p_id uuid, p_status text, p_error text default null, p_used boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform vault_service_guard();
  if p_status not in ('active', 'error', 'needs_reauth') then raise exception 'connector_mark: bad status' using errcode = '22023'; end if;
  update connectors set
    status = case when status = 'disabled' then status else p_status end,
    last_error = case when p_status = 'active' then null else left(p_error, 300) end,
    last_checked_at = now(),
    last_used_at = case when p_used then now() else last_used_at end
  where id = p_id;
end $$;

-- ---------- CEO (dashboard) ----------
-- Giving more agents access, raising a Gmail permission level, or re-enabling loosens access → fresh 2FA code.
create or replace function connector_set_grants(p_id uuid, p_agents text[])
returns void language plpgsql security definer set search_path = public as $$
declare added text[];
begin
  perform hq_guard();
  if not exists (select 1 from connectors where id = p_id) then raise exception 'connector_set_grants: unknown connector' using errcode = 'P0002'; end if;
  select coalesce(array_agg(a), '{}') into added from unnest(coalesce(p_agents, '{}')) a
  where not exists (select 1 from connector_grants g where g.connector_id = p_id and g.agent_id = a);
  if cardinality(added) > 0 then perform ceo_step_up_guard(); end if;
  delete from connector_grants where connector_id = p_id and not (agent_id = any (coalesce(p_agents, '{}')));
  insert into connector_grants (connector_id, agent_id)
    select p_id, a from unnest(coalesce(p_agents, '{}')) a where exists (select 1 from agents where id = a)
  on conflict do nothing;
  perform hq_log('ceo', 'connector.grants', null, null, jsonb_build_object('connector_id', p_id, 'agents', coalesce(p_agents, '{}')));
end $$;

create or replace function connector_update(p_id uuid, p_name text, p_settings jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare c connectors;
begin
  perform hq_guard();
  select * into c from connectors where id = p_id;
  if c.id is null then raise exception 'connector_update: unknown connector' using errcode = 'P0002'; end if;
  if not connector_mode_ok(c.kind, p_settings) then raise exception 'connector_update: bad mode' using errcode = '22023'; end if;
  if c.kind = 'gmail' and connector_mode_rank(p_settings) > connector_mode_rank(c.settings) then
    perform ceo_step_up_guard();
  end if;
  update connectors set name = coalesce(nullif(left(trim(p_name), 120), ''), name), settings = coalesce(p_settings, settings)
  where id = p_id;
  perform hq_log('ceo', 'connector.updated', null, null, jsonb_build_object('connector_id', p_id, 'settings', p_settings));
end $$;

create or replace function connector_set_status(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  if p_status not in ('active', 'disabled') then raise exception 'connector_set_status: bad status' using errcode = '22023'; end if;
  if p_status = 'active' then perform ceo_step_up_guard(); end if;
  update connectors set status = p_status, last_error = null where id = p_id;
  if not found then raise exception 'connector_set_status: unknown connector' using errcode = 'P0002'; end if;
  perform hq_log('ceo', 'connector.' || case when p_status = 'active' then 'enabled' else 'disabled' end, null, null,
                 jsonb_build_object('connector_id', p_id));
end $$;

create or replace function connector_delete(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c connectors;
begin
  perform hq_guard();
  delete from connectors where id = p_id returning * into c;
  if c.id is null then raise exception 'connector_delete: unknown connector' using errcode = 'P0002'; end if;
  perform hq_log('ceo', 'connector.removed', null, null, jsonb_build_object('connector_id', p_id, 'kind', c.kind, 'name', c.name));
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'connector_set_grants(uuid, text[])', 'connector_update(uuid, text, jsonb)', 'connector_set_status(uuid, text)',
    'connector_delete(uuid)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'connector_insert(uuid, text, text, text, text, text, jsonb, bytea, bytea, int, text[], text)',
    'connector_rotate_secret(uuid, bytea, bytea, int)', 'connectors_for_agent(text, text)', 'connector_get_sealed(uuid)',
    'connector_mark(uuid, text, text, boolean)', 'connector_mode_ok(text, jsonb)', 'connector_mode_rank(jsonb)']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
