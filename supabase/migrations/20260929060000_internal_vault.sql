-- RizeHub HQ · Internal vault: "Admin → Tool logins" (docs/06 §11, docs/09 "Internal vault").
-- The agency's OWN tool logins (Semrush, Canva, hosting, Shopify Partner, …) reuse the Client Vault unchanged:
-- they are client_credentials of one special client row, `clients.is_internal = true` ("RizeHub (internal)").
-- Same encryption (worker only), grants, URL/write allowlists, failed-login stop, 2FA handoff and access log.
-- The one difference: an agent may use a granted internal login in ANY task (with or without a client), so
-- vault_list_for_agent also returns the internal client's credentials granted to that agent ('tools').
-- vault_get_for_agent already checks only the grant (not the task's client), so it needs no change.
--
-- Callers
--   CEO (dashboard) / worker → internal_client_id()            (creates the row on first call)
--   worker (service role)    → vault_list_for_agent(agent, client | null)

-- ---------- the internal client ----------
alter table clients add column if not exists is_internal boolean not null default false;
create unique index if not exists clients_one_internal on clients (is_internal) where is_internal;
grant select (is_internal) on clients to authenticated;

-- The internal client holds the tool logins: it can never be archived (archiving revokes every grant),
-- deleted (would cascade-delete the logins) or turned into / out of a customer.
create or replace function clients_protect_internal() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.is_internal then raise exception 'The internal RizeHub client (tool logins) cannot be deleted'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and new.is_internal is distinct from old.is_internal then
    raise exception 'is_internal cannot be changed';
  end if;
  if new.is_internal and new.status = 'archived' then
    raise exception 'The internal RizeHub client (tool logins) cannot be archived';
  end if;
  return new;
end $$;
drop trigger if exists t_clients_protect_internal on clients;
create trigger t_clients_protect_internal before insert or update or delete on clients
  for each row execute function clients_protect_internal();

-- The internal client's id, created on first call. CEO session or service role (hq_guard).
create or replace function internal_client_id() returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  perform hq_guard();
  select id into cid from clients where is_internal;
  if cid is not null then return cid; end if;
  insert into clients (name, slug, is_internal, notes)
  values ('RizeHub (internal)', 'rizehub-internal', true,
          'The agency''s own tool logins (Admin → Tool logins). Not a customer: hidden from client lists, never archived.')
  on conflict do nothing
  returning id into cid;
  if cid is null then select id into cid from clients where is_internal; end if;  -- lost a race: someone else created it
  if cid is null then raise exception 'the slug "rizehub-internal" is taken by a customer; rename that client first'; end if;
  insert into activity_log (actor, action, client_id, detail) values ('system', 'vault.internal_client', cid, '{}');
  return cid;
end $$;

-- ---------- agent side ----------
-- Metadata (never ciphertext) of one client's usable credentials granted to the agent.
create or replace function vault_granted_meta(p_agent text, p_client uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'platform', c.platform, 'label', c.label, 'login_url', c.login_url, 'username', c.username,
      'secret_type', c.secret_type, 'twofa_method', c.twofa_method, 'scope_notes', c.scope_notes,
      'url_allowlist', c.url_allowlist, 'write_allowlist', c.write_allowlist, 'status', c.status, 'expires_at', c.expires_at,
      'last_used_at', c.last_used_at)
      order by c.platform, c.label), '[]')
    from client_credentials c
    join credential_grants g on g.credential_id = c.id and g.agent_id = p_agent
    join clients cl on cl.id = c.client_id
   where c.client_id = p_client and c.status <> 'revoked' and cl.status <> 'archived';
$$;

create or replace function vault_not_granted_count(p_agent text, p_client uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from client_credentials c
   where c.client_id = p_client and c.status <> 'revoked'
     and not exists (select 1 from credential_grants g where g.credential_id = c.id and g.agent_id = p_agent);
$$;

-- p_client null = a task without a client: only the agency's tool logins.
-- 'tools' = the internal client's credentials granted to this agent (empty when p_client IS the internal client:
-- they are already in 'granted').
create or replace function vault_list_for_agent(p_agent text, p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cl clients; ic uuid;
begin
  perform vault_service_guard();
  if p_client is not null then
    select * into cl from clients where id = p_client;
    if cl.id is null then raise exception 'client not found'; end if;
  end if;
  select id into ic from clients where is_internal;
  if ic is not null and ic is not distinct from cl.id then ic := null; end if;
  return jsonb_build_object(
    'client', case when cl.id is null then null
                   else jsonb_build_object('id', cl.id, 'name', cl.name, 'slug', cl.slug, 'status', cl.status, 'is_internal', cl.is_internal) end,
    'granted', case when cl.id is null then '[]'::jsonb else vault_granted_meta(p_agent, cl.id) end,
    'not_granted', case when cl.id is null then 0 else vault_not_granted_count(p_agent, cl.id) end,
    'tools', case when ic is null then '[]'::jsonb else vault_granted_meta(p_agent, ic) end,
    'tools_not_granted', case when ic is null then 0 else vault_not_granted_count(p_agent, ic) end);
end $$;

-- ---------- permissions ----------
do $$
declare f text;
begin
  -- CEO (dashboard) + worker
  foreach f in array array['internal_client_id()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  -- worker only / internal
  foreach f in array array['vault_list_for_agent(text,uuid)', 'vault_granted_meta(text,uuid)', 'vault_not_granted_count(text,uuid)',
    'clients_protect_internal()']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
