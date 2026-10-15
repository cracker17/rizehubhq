-- Julev Operator phase 3, milestone 5 (docs/17-OPERATOR.md "WhatsApp Business"): a client's WhatsApp Business number
-- through Meta's Cloud API. Messages arrive by webhook (dashboard /api/operator/whatsapp → hq-operator, which checks
-- Meta's signature) and go through the same classify / draft / tiers; approved replies are SENT by the API, quoting the
-- customer's message, only inside WhatsApp's 24 h customer-service window (outside it a template would be needed: the
-- send fails and says so, never retried).
--   channel  = one business number of one client (kind 'whatsapp', url https://wa.me/<number>, wa_phone_id = Meta's
--              phone number id the webhook names); thread_key = the customer's WhatsApp id; external_id = the wamid

alter table operator_channels drop constraint if exists operator_channels_kind_check;
alter table operator_channels add constraint operator_channels_kind_check check (kind in ('google_chat', 'gmail', 'slack', 'teams', 'whatsapp'));
alter table operator_channels add column if not exists wa_phone_id text check (wa_phone_id is null or wa_phone_id ~ '^\d{6,30}$');
create unique index if not exists operator_channels_wa_phone on operator_channels (wa_phone_id) where wa_phone_id is not null;

create or replace function operator_channel_url_ok(p_kind text, p_url text) returns boolean
language sql immutable set search_path = public as $$
  select case p_kind
    when 'google_chat' then p_url ~ '^https://chat\.google\.com/' or p_url ~ '^https://mail\.google\.com/chat/'
    when 'gmail' then p_url ~ '^https://mail\.google\.com/mail/'
    when 'slack' then p_url ~ '^https://app\.slack\.com/client/' or p_url ~ '^https://[a-z0-9-]+\.slack\.com/(archives|messages)/'
    when 'teams' then p_url ~ '^https://teams\.(microsoft|live|cloud\.microsoft)\.com/' or p_url ~ '^https://teams\.cloud\.microsoft/'
    when 'whatsapp' then p_url ~ '^https://wa\.me/\d{6,15}$'
    else false end;
$$;

create or replace function operator_channel_sends(p_kind text) returns boolean
language sql immutable set search_path = public as $$
  select p_kind in ('google_chat', 'whatsapp');
$$;

-- The CEO connects a WhatsApp Business number to a client (number as shown to customers, Meta's phone number id).
create or replace function operator_add_whatsapp(p_client text, p_name text, p_number text, p_phone_id text) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid; n text := left(btrim(coalesce(p_name, '')), 120); num text := regexp_replace(coalesce(p_number, ''), '\D', '', 'g');
        pid text := btrim(coalesce(p_phone_id, ''));
begin
  perform hq_guard();
  if not exists (select 1 from operator_clients where slug = p_client) then raise exception 'unknown client %', p_client; end if;
  if n = '' then raise exception 'give it a name'; end if;
  if num !~ '^\d{6,15}$' then raise exception 'the number must be the full international number, e.g. +63 917 123 4567'; end if;
  if pid !~ '^\d{6,30}$' then raise exception 'the phone number ID is the long number from Meta (WhatsApp → API setup)'; end if;
  if exists (select 1 from operator_channels where wa_phone_id = pid and client_slug <> p_client) then
    raise exception 'that WhatsApp number is already connected to another client';
  end if;
  insert into operator_channels (client_slug, kind, name, url, wa_phone_id) values (p_client, 'whatsapp', n, 'https://wa.me/' || num, pid)
  on conflict (client_slug, url) do update set name = excluded.name, kind = 'whatsapp', wa_phone_id = excluded.wa_phone_id, enabled = true
  returning id into cid;
  perform operator_log('ceo', 'channel.added', p_client, null, jsonb_build_object('channel', n, 'kind', 'whatsapp'));
  return cid;
end $$;

-- A webhook message for a business number: stored on that number's channel like a polled message (never a baseline).
-- Returns the inbox id, or null when the number is unknown / not watched or the message is a repeat.
create or replace function operator_whatsapp_ingest(p_phone_id text, p_msg jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare ch operator_channels; nid uuid;
begin
  perform hq_guard();
  select * into ch from operator_channels where wa_phone_id = p_phone_id and kind = 'whatsapp';
  if ch.id is null or not ch.enabled then return null; end if;
  if coalesce(p_msg ->> 'external_id', '') = '' or coalesce(p_msg ->> 'thread_key', '') = '' then raise exception 'a WhatsApp message needs its id and sender'; end if;
  nid := operator_ingest(ch.id, (p_msg - 'baseline') || jsonb_build_object('space_name', ch.name, 'url', ch.url));
  update operator_channels set last_polled_at = now(), last_error = null where id = ch.id;
  return nid;
end $$;

-- When the customer last wrote (the 24 h window for free-form replies).
create or replace function operator_whatsapp_last_inbound(p_channel uuid, p_wa text) returns timestamptz
language sql stable security definer set search_path = public as $$
  select max(coalesce(sent_at, created_at)) from operator_inbox where channel_id = p_channel and thread_key = p_wa and not from_me;
$$;

do $$
declare f text;
begin
  foreach f in array array['operator_channel_url_ok(text,text)', 'operator_channel_sends(text)', 'operator_whatsapp_ingest(text,jsonb)',
                           'operator_whatsapp_last_inbound(uuid,text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  execute 'revoke execute on function operator_add_whatsapp(text,text,text,text) from public, anon';
  execute 'grant execute on function operator_add_whatsapp(text,text,text,text) to authenticated, service_role';
end $$;
