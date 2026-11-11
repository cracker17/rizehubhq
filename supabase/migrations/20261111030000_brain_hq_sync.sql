-- HQ Brain P3: HQ Sync for team members' PCs (vault onboarding-and-access-plan.md §5). A member's computer gets a
-- filtered local copy (only their granted projects; no git, no GitHub account). The device token from the setup link
-- authenticates the sync script; what it may download/upload is decided by the person's live grants (apps/brain/src/access.ts).
-- Revoking a project removes its files from the PC at the next sync.

alter table brain_devices add column if not exists person_id uuid references brain_people (id) on delete cascade;

-- CEO: a device for a person (track 'member') or for the owner (track 'owner').
create or replace function brain_device_create_for(p_name text, p_kind text, p_person uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_person brain_people;
  v_dev jsonb;
begin
  perform hq_guard();
  if p_person is null then return brain_device_create(p_name, p_kind, 'Julev', 'owner'); end if;
  select * into v_person from brain_people where id = p_person and disabled_at is null;
  if v_person.id is null then raise exception 'Unknown person.' using errcode = 'P0002'; end if;
  v_dev := brain_device_create(p_name, p_kind, v_person.name, 'member');
  update brain_devices set person_id = p_person where id = (v_dev->>'id')::uuid;
  return v_dev;
end $$;

-- Service: who is behind a device token (for HQ Sync). Null = unknown/revoked device, or a person who was disabled.
create or replace function brain_device_owner(p_token_hash text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('device_id', d.id, 'device_name', d.name, 'track', d.track, 'person_id', d.person_id,
                            'user_id', p.user_id, 'person', case when d.person_id is null then null else brain_person_access(p.user_id) end)
    from brain_devices d left join brain_people p on p.id = d.person_id
   where d.token_hash = p_token_hash and d.revoked_at is null
     and (d.person_id is null or (p.disabled_at is null and p.joined_at is not null));
$$;

-- A member PC counts as ready after its first successful HQ Sync (its round trip is the download itself).
create or replace function brain_device_mark_ready(p_token_hash text) returns boolean
language sql security definer set search_path = public, extensions as $$
  with u as (update brain_devices set ready_at = coalesce(ready_at, now())
              where token_hash = p_token_hash and revoked_at is null and track = 'member' returning 1)
  select exists (select 1 from u);
$$;
revoke execute on function brain_device_mark_ready(text) from public, anon, authenticated;
grant execute on function brain_device_mark_ready(text) to service_role;

do $$ begin
  execute 'revoke execute on function brain_device_create_for(text, text, uuid) from public, anon';
  execute 'grant execute on function brain_device_create_for(text, text, uuid) to authenticated, service_role';
  execute 'revoke execute on function brain_device_owner(text) from public, anon, authenticated';
  execute 'grant execute on function brain_device_owner(text) to service_role';
end $$;
