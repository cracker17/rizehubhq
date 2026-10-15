-- Julev Operator phase 3, milestone 6a (docs/17-OPERATOR.md "Unread sweep"): the operator looks for unread chats
-- itself instead of only reading the chats the CEO added.
--   operator_accounts   one per app a client's browser profile is logged into (Google Chat, Slack, Teams, Gmail). Every
--                       sweep the operator opens the app's home in that profile, reads the unread list, and reads each
--                       unread conversation (found = an auto-discovered channel; only its unread messages count as new)
--   reply_when          per client: 'addressed' (default) = draft replies only to direct messages, @Julev mentions and
--                       questions to Julev; everything else is stored as FYI. 'all' = phase 1 behaviour.
-- WhatsApp Business needs no sweep: every chat arrives by webhook. Approved replies on Slack / Teams / Gmail stay
-- "you post it" (milestone 6b adds posting behind a send test).

create table operator_accounts (
  id             uuid primary key default gen_random_uuid(),
  client_slug    text not null references operator_clients(slug) on delete cascade,
  kind           text not null check (kind in ('google_chat', 'gmail', 'slack', 'teams')),
  label          text not null check (length(label) between 1 and 120),
  home_url       text not null check (home_url ~ '^https://[^\s]+$'),
  enabled        boolean not null default true,
  last_swept_at  timestamptz,
  last_found     int not null default 0,
  last_error     text,
  created_at     timestamptz not null default now(),
  unique (client_slug, kind, home_url)
);
alter table operator_accounts enable row level security;
create policy ceo_read on operator_accounts for select to authenticated using (is_ceo());
revoke all on operator_accounts from anon, authenticated;
grant select on operator_accounts to authenticated;

alter table operator_channels add column if not exists direct boolean not null default false;          -- a DM / inbox
alter table operator_channels add column if not exists auto_discovered boolean not null default false;
alter table operator_channels add column if not exists account_id uuid references operator_accounts(id) on delete set null;
alter table operator_clients add column if not exists reply_when text not null default 'addressed' check (reply_when in ('addressed', 'all'));

-- ---------- the "addressed to Julev" rule, in front of the tiers ----------
-- The phase 1 function keeps the tiers; this wrapper turns a draft for a message nobody addressed to Julev into FYI
-- (kept in the inbox and the digests, no draft, no approval). Addressed = a direct chat (DM, WhatsApp, Gmail inbox), an
-- @mention of Julev, or the classifier's addressed_to_julev (a question to him in a thread he is in).
alter function operator_record_draft(uuid, jsonb) rename to operator_record_draft_tiers;

create or replace function operator_record_draft(p_inbox uuid, p_result jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare r operator_inbox; c operator_clients; ch operator_channels; addressed boolean; res jsonb := p_result;
begin
  perform hq_guard();
  select * into r from operator_inbox where id = p_inbox;
  if r.id is not null and coalesce(p_result ->> 'category', '') in ('reply', 'task') then
    select * into c from operator_clients where slug = r.client_slug;
    select * into ch from operator_channels where id = r.channel_id;
    addressed := ch.direct or ch.kind = 'whatsapp' or r.mentions_me or coalesce((p_result ->> 'addressed_to_julev')::boolean, false);
    if coalesce(c.reply_when, 'addressed') = 'addressed' and not addressed then
      res := p_result || jsonb_build_object('category', 'fyi', 'draft', '', 'not_addressed', true, 'drafted_category', p_result ->> 'category');
    end if;
  end if;
  return operator_record_draft_tiers(p_inbox, res);
end $$;

-- ---------- CEO: accounts and the reply rule ----------
create or replace function operator_add_account(p_client text, p_kind text, p_label text, p_home_url text) returns uuid
language plpgsql security definer set search_path = public as $$
declare aid uuid; u text := btrim(coalesce(p_home_url, '')); l text := left(btrim(coalesce(p_label, '')), 120);
begin
  perform hq_guard();
  if not exists (select 1 from operator_clients where slug = p_client) then raise exception 'unknown client %', p_client; end if;
  if p_kind not in ('google_chat', 'gmail', 'slack', 'teams') then raise exception 'unknown kind %', p_kind; end if;
  if not operator_channel_url_ok(p_kind, u) then raise exception 'that is not a % address', p_kind; end if;
  if l = '' then l := initcap(replace(p_kind, '_', ' ')); end if;
  insert into operator_accounts (client_slug, kind, label, home_url) values (p_client, p_kind, l, u)
  on conflict (client_slug, kind, home_url) do update set label = excluded.label, enabled = true
  returning id into aid;
  perform operator_log('ceo', 'account.added', p_client, null, jsonb_build_object('kind', p_kind, 'label', l));
  return aid;
end $$;

create or replace function operator_set_account_enabled(p_account uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare a operator_accounts;
begin
  perform hq_guard();
  update operator_accounts set enabled = coalesce(p_enabled, false) where id = p_account returning * into a;
  if a.id is null then raise exception 'unknown account'; end if;
  perform operator_log('ceo', case when a.enabled then 'account.enabled' else 'account.disabled' end, a.client_slug, null, jsonb_build_object('kind', a.kind, 'label', a.label));
  return a.enabled;
end $$;

create or replace function operator_set_reply_when(p_client text, p_mode text) returns text
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  if p_mode not in ('addressed', 'all') then raise exception 'reply_when must be addressed or all'; end if;
  update operator_clients set reply_when = p_mode where slug = p_client;
  if not found then raise exception 'unknown client %', p_client; end if;
  perform operator_log('ceo', 'reply_when.changed', p_client, null, jsonb_build_object('mode', p_mode));
  return p_mode;
end $$;

-- ---------- operator (service): sweep bookkeeping ----------
-- An unread conversation the sweep found: its channel (created on first sight, flagged auto-discovered). A channel the
-- CEO stopped stays stopped. Returns the channel id, whether it was created, and whether it is enabled.
create or replace function operator_discover(p_account uuid, p_name text, p_url text, p_direct boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a operator_accounts; ch operator_channels; created boolean := false; n text := left(btrim(coalesce(p_name, '')), 120);
begin
  perform hq_guard();
  select * into a from operator_accounts where id = p_account;
  if a.id is null then raise exception 'unknown account'; end if;
  if not operator_channel_url_ok(a.kind, p_url) then raise exception 'not a % address: %', a.kind, left(p_url, 120); end if;
  select * into ch from operator_channels where client_slug = a.client_slug and url = p_url;
  if ch.id is null then
    insert into operator_channels (client_slug, kind, name, url, direct, auto_discovered, account_id)
    values (a.client_slug, a.kind, coalesce(nullif(n, ''), a.label), p_url, coalesce(p_direct, false), true, a.id)
    returning * into ch;
    created := true;
    perform operator_log('operator', 'channel.discovered', a.client_slug, null, jsonb_build_object('channel', ch.name, 'kind', a.kind, 'direct', ch.direct));
  elsif ch.direct is distinct from coalesce(p_direct, ch.direct) and ch.auto_discovered then
    update operator_channels set direct = p_direct where id = ch.id returning * into ch;
  end if;
  return jsonb_build_object('channel_id', ch.id, 'created', created, 'enabled', ch.enabled);
end $$;

-- After each sweep: stamp it; a new error is one watch.failed notice (Telegram "can't read"), recovery one line.
create or replace function operator_account_swept(p_account uuid, p_found int, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
declare a operator_accounts;
begin
  perform hq_guard();
  select * into a from operator_accounts where id = p_account for update;
  if a.id is null then raise exception 'unknown account'; end if;
  update operator_accounts set last_swept_at = now(), last_found = greatest(coalesce(p_found, 0), 0), last_error = left(nullif(p_error, ''), 1000)
   where id = a.id;
  if nullif(p_error, '') is not null and a.last_error is distinct from left(p_error, 1000) then
    perform operator_log('operator', 'watch.failed', a.client_slug, null, jsonb_build_object('channel', a.label || ' (unread sweep)', 'error', left(p_error, 300)), false);
  elsif nullif(p_error, '') is null and a.last_error is not null then
    perform operator_log('operator', 'watch.recovered', a.client_slug, null, jsonb_build_object('channel', a.label || ' (unread sweep)'));
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array['operator_record_draft_tiers(uuid,jsonb)', 'operator_record_draft(uuid,jsonb)',
                           'operator_discover(uuid,text,text,boolean)', 'operator_account_swept(uuid,int,text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['operator_add_account(text,text,text,text)', 'operator_set_account_enabled(uuid,boolean)',
                           'operator_set_reply_when(text,text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
