-- M13.5 Storage (docs/15 §6): Google Drive and Dropbox connections where agents save deliverables and images.
-- A storage connection is a `connectors` row of kind 'storage' (settings: {"provider": "drive" | "dropbox", "default": true?}).
-- Its secret (client id/secret + refresh token, sealed by the worker with context 'connector:<id>') follows the same
-- rules as every connector: the CEO reads metadata only; ciphertext is service-role only.
-- The default storage is the one with settings.default = true (set by the CEO through storage_set_default); with none
-- marked, the oldest active storage connection is used.

-- Widen the kind check. 'ical' (calendar feeds, migration 20260929090000) is included too, so whichever of the two
-- migrations runs last never drops the other's kind.
alter table connectors drop constraint if exists connectors_kind_check;
alter table connectors add constraint connectors_kind_check check (kind in ('gmail', 'mcp', 'storage', 'ical'));

-- ---------- CEO (dashboard) ----------
-- Picks the storage every automatic save goes to. Not a loosening of access (it's the CEO's own storage), so no step-up.
create or replace function storage_set_default(p_connector uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c connectors;
begin
  perform hq_guard();
  select * into c from connectors where id = p_connector for update;
  if c.id is null or c.kind <> 'storage' then
    raise exception 'storage_set_default: unknown storage connection' using errcode = 'P0002';
  end if;
  update connectors set settings = settings - 'default' where kind = 'storage' and id <> p_connector and settings ? 'default';
  update connectors set settings = settings || '{"default": true}'::jsonb where id = p_connector;
  perform hq_log('ceo', 'storage.default_set', null, null,
                 jsonb_build_object('connector_id', p_connector, 'provider', c.settings ->> 'provider', 'name', c.name));
end $$;

-- ---------- worker only ----------
-- The storage connection to save to now (default first, else the oldest active one), with its sealed secret.
create or replace function storage_default_connector()
returns table (id uuid, kind text, name text, account_email text, url text, auth_type text, settings jsonb, status text,
               secret_cipher bytea, secret_iv bytea, key_version int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform vault_service_guard();
  return query
    select c.id, c.kind, c.name, c.account_email, c.url, c.auth_type, c.settings, c.status, c.secret_cipher, c.secret_iv, c.key_version
    from connectors c
    where c.kind = 'storage' and c.status = 'active'
    order by (c.settings @> '{"default": true}'::jsonb) desc, c.created_at
    limit 1;
end $$;

-- After a QA-passed deliverable is saved: the links ride on the task output and on the CEO's pending deliverable card.
create or replace function task_record_storage(p_task uuid, p_storage jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform vault_service_guard();
  if jsonb_typeof(p_storage) is distinct from 'object' then raise exception 'task_record_storage: bad payload' using errcode = '22023'; end if;
  update tasks set output = coalesce(output, '{}'::jsonb) || jsonb_build_object('storage', p_storage) where id = p_task;
  if not found then raise exception 'task_record_storage: unknown task' using errcode = 'P0002'; end if;
  update approvals set payload = jsonb_set(payload, '{output,storage}', p_storage, true)
  where task_id = p_task and kind = 'deliverable' and status = 'pending' and jsonb_typeof(payload -> 'output') = 'object';
end $$;

revoke execute on function storage_set_default(uuid) from public, anon;
grant execute on function storage_set_default(uuid) to authenticated, service_role;
revoke execute on function storage_default_connector() from public, anon, authenticated;
grant execute on function storage_default_connector() to service_role;
revoke execute on function task_record_storage(uuid, jsonb) from public, anon, authenticated;
grant execute on function task_record_storage(uuid, jsonb) to service_role;
