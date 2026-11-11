-- HQ Brain P1: devices + "Set up a computer" wizard (vault projects/hq-brain/onboarding-and-access-plan.md, Process v2).
-- A device is one computer (kind 'pc': installer + local vault + 15-min sync) or one Claude app (kind 'claude': connector
-- only). The CEO creates it in the wizard and gets a one-time setup link (30 min). The installer redeems the link for a
-- device token (only sha256 hashes are stored) and reports every checklist step; sync.ps1 keeps reporting after that.
-- The last step is a round trip: the PC writes devices/<id>.md with a nonce, sync pushes it, the indexer sees it.

create table brain_devices (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (char_length(name) between 1 and 60),
  kind              text not null check (kind in ('pc', 'claude')),
  owner_label       text not null default 'Julev' check (char_length(owner_label) between 1 and 80),
  track             text not null default 'owner' check (track in ('owner', 'member')), -- owner: git vault; member: HQ Sync (P3)
  setup_code_hash   text unique,
  setup_expires_at  timestamptz,
  setup_used_at     timestamptz,
  token_hash        text unique,
  checklist         jsonb not null default '{}',   -- {step: {s: wait|run|done|fail|skip, detail, at}}
  info              jsonb not null default '{}',   -- os, ps, git, claude app, vault_path, installer version
  roundtrip         jsonb not null default '{}',   -- {nonce, written_at, pushed_at, indexed_at, readable_at}
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz,
  last_pull_at      timestamptz,
  last_push_at      timestamptz,
  last_sync_error   text,
  ready_at          timestamptz,
  revoked_at        timestamptz
);
create index brain_devices_created on brain_devices (created_at desc);

alter table brain_devices enable row level security;
create policy ceo_read on brain_devices for select to authenticated using (is_ceo());
revoke all on brain_devices from anon, authenticated;
-- the browser never needs the hashes
grant select (id, name, kind, owner_label, track, setup_expires_at, setup_used_at, checklist, info, roundtrip, created_at,
              last_seen_at, last_pull_at, last_push_at, last_sync_error, ready_at, revoked_at) on brain_devices to authenticated;

-- One device as the UI sees it (no hashes). For 'claude' devices the checklist is derived from the connector: a new
-- approval after the device was created ticks "connected", a brain_load_project call after that ticks "tested".
create or replace function brain_device_view(d brain_devices) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'id', d.id, 'name', d.name, 'kind', d.kind, 'owner_label', d.owner_label, 'track', d.track,
    'setup_expires_at', d.setup_expires_at, 'setup_used_at', d.setup_used_at,
    'checklist', d.checklist, 'info', d.info, 'roundtrip', d.roundtrip - 'nonce',
    'created_at', d.created_at, 'last_seen_at', d.last_seen_at, 'last_pull_at', d.last_pull_at, 'last_push_at', d.last_push_at,
    'last_sync_error', d.last_sync_error, 'ready_at', d.ready_at, 'revoked_at', d.revoked_at,
    'connected_at', (select min(t.created_at) from brain_tokens t where t.created_at >= d.created_at and t.subject = 'ceo'),
    'tested_at', (select min(e.ts) from brain_events e where e.ts >= d.created_at and e.action = 'tool_call'
                    and e.meta->>'tool' = 'brain_load_project' and coalesce((e.meta->>'ok')::boolean, true)));
$$;

-- CEO: new device + its one-time setup link code (returned once, never stored in clear).
create or replace function brain_device_create(p_name text, p_kind text, p_owner_label text default 'Julev', p_track text default 'owner')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_row brain_devices;
begin
  perform hq_guard();
  if coalesce(btrim(p_name), '') = '' then raise exception 'Give the device a name.' using errcode = '22023'; end if;
  insert into brain_devices (name, kind, owner_label, track, setup_code_hash, setup_expires_at)
  values (left(btrim(p_name), 60), p_kind, left(coalesce(nullif(btrim(p_owner_label), ''), 'Julev'), 80), coalesce(p_track, 'owner'),
          case when p_kind = 'pc' then encode(sha256(convert_to(v_code, 'utf8')), 'hex') end,
          case when p_kind = 'pc' then now() + interval '30 minutes' end)
  returning * into v_row;
  perform brain_log_event('julev', 'device_created', null, null, v_row.name, jsonb_build_object('device', v_row.id, 'kind', v_row.kind));
  return brain_device_view(v_row) || jsonb_build_object('code', case when p_kind = 'pc' then v_code end);
end $$;

-- CEO: a fresh link for a device whose link expired or failed (old link stops working).
create or replace function brain_device_new_link(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_row brain_devices;
begin
  perform hq_guard();
  update brain_devices set setup_code_hash = encode(sha256(convert_to(v_code, 'utf8')), 'hex'),
         setup_expires_at = now() + interval '30 minutes', setup_used_at = null, token_hash = null
   where id = p_id and kind = 'pc' and revoked_at is null
  returning * into v_row;
  if v_row.id is null then raise exception 'Unknown device.' using errcode = 'P0002'; end if;
  return brain_device_view(v_row) || jsonb_build_object('code', v_code);
end $$;

create or replace function brain_devices_list() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform hq_guard();
  return coalesce((select jsonb_agg(brain_device_view(d) order by d.created_at desc) from brain_devices d where d.revoked_at is null), '[]'::jsonb);
end $$;

create or replace function brain_device_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_row brain_devices;
begin
  perform hq_guard();
  select * into v_row from brain_devices where id = p_id;
  if v_row.id is null then return null; end if;
  return brain_device_view(v_row);
end $$;

create or replace function brain_device_revoke(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform hq_guard();
  update brain_devices set revoked_at = now(), token_hash = null, setup_code_hash = null where id = p_id and revoked_at is null;
  perform brain_log_event('julev', 'device_revoked', null, null, (select name from brain_devices where id = p_id), jsonb_build_object('device', p_id));
end $$;

-- ---------- service (hq-brain): installer + sync.ps1 ----------

-- Redeem a setup link: single use, 30 min. Stores the device token hash. Returns what the installer script needs, or null.
create or replace function brain_device_redeem(p_code_hash text, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_row brain_devices;
begin
  update brain_devices set setup_used_at = now(), token_hash = p_token_hash, last_seen_at = now()
   where setup_code_hash = p_code_hash and setup_used_at is null and setup_expires_at > now() and revoked_at is null
  returning * into v_row;
  if v_row.id is null then return null; end if;
  perform brain_log_event('installer', 'device_setup_started', null, null, v_row.name, jsonb_build_object('device', v_row.id));
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'track', v_row.track, 'owner_label', v_row.owner_label);
end $$;

-- A report from the installer or sync.ps1. p: {step?, s?, detail?, info?: {...}, pull_ok?, push_ok?, error?, roundtrip?: {nonce?, written_at?, pushed_at?}}
create or replace function brain_device_report(p_token_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_row brain_devices; v_step text := left(p->>'step', 40);
begin
  select * into v_row from brain_devices where token_hash = p_token_hash and revoked_at is null;
  if v_row.id is null then return null; end if;
  update brain_devices set
    checklist = case when v_step is null then checklist
                     else checklist || jsonb_build_object(v_step, jsonb_build_object(
                       's', case when p->>'s' in ('wait', 'run', 'done', 'fail', 'skip') then p->>'s' else 'done' end,
                       'detail', left(coalesce(p->>'detail', ''), 300), 'at', now())) end,
    info = info || coalesce(case when jsonb_typeof(p->'info') = 'object' then p->'info' end, '{}'),
    roundtrip = case when jsonb_typeof(p->'roundtrip') = 'object' then roundtrip || (p->'roundtrip') else roundtrip end,
    last_seen_at = now(),
    last_pull_at = case when (p->>'pull_ok')::boolean then now() else last_pull_at end,
    last_push_at = case when (p->>'push_ok')::boolean then now() else last_push_at end,
    last_sync_error = case when p ? 'error' then nullif(left(p->>'error', 300), '') else last_sync_error end
  where id = v_row.id;
  return jsonb_build_object('id', v_row.id, 'ok', true);
end $$;

-- The indexer saw devices/<id>.md with this nonce (stage 'indexed'), then read it back through the API ('readable').
create or replace function brain_device_roundtrip(p_nonce text, p_stage text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if p_stage not in ('indexed', 'readable') or coalesce(p_nonce, '') = '' then return false; end if;
  update brain_devices set
    roundtrip = roundtrip || jsonb_build_object(p_stage || '_at', now()),
    ready_at = case when p_stage = 'readable' then coalesce(ready_at, now()) else ready_at end
  where roundtrip->>'nonce' = p_nonce and revoked_at is null
  returning id into v_id;
  if v_id is not null and p_stage = 'readable' then
    perform brain_log_event('brain-service', 'device_ready', null, null, (select name from brain_devices where id = v_id), jsonb_build_object('device', v_id));
  end if;
  return v_id is not null;
end $$;

do $$
declare f text;
begin
  foreach f in array array['brain_device_create(text, text, text, text)', 'brain_device_new_link(uuid)', 'brain_devices_list()',
                           'brain_device_get(uuid)', 'brain_device_revoke(uuid)', 'brain_device_view(brain_devices)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array['brain_device_redeem(text, text)', 'brain_device_report(text, jsonb)', 'brain_device_roundtrip(text, text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

grant select, insert, update on brain_devices to service_role;

-- Live wizard: the checklist ticks over realtime (falls back to polling in the UI).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table brain_devices';
  end if;
exception when duplicate_object then null;
end $$;
