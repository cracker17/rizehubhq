-- Julev Operator, phase 1 (docs/17-OPERATOR.md): watch client chats through logged-in browser profiles, classify each new
-- message, draft a reply with the client's project memory, and send it only through tiered approvals. The operator app
-- (apps/operator, service role) is the only writer; the CEO reads everything and decides through the normal Approvals
-- inbox / Telegram (an approval with payload.type 'operator_reply': not high-risk, so Telegram can approve it).
--
--   operator_clients    one row per client the operator watches (browser profile, vault project, client rules, pause)
--   operator_channels   the chat spaces / DMs watched per client (Google Chat first), with the poll cursor
--   operator_inbox      every new message seen; its classification, draft, approval and send state
--   operator_actions    append-only audit log of everything the operator did or was told (live feed on /operator)
--   operator_autonomy   per client (or '*' = default) and per action type: auto | approve | never
--   settings rows       operator_paused (kill switch: no sends at all while true), operator_auto_send (tier 1 on/off)
--
-- Every send goes through operator_claim_send(): it refuses while the kill switch, the office pause or the client pause
-- is on, so a stopped operator can never post, whatever the worker thinks.

-- ---------- clients ----------
create table operator_clients (
  slug           text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name           text not null,
  client_id      uuid references clients(id) on delete set null,
  brain_project  text check (brain_project is null or brain_project ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  profile        text not null check (profile ~ '^[a-z0-9][a-z0-9-]{0,63}$'),   -- workspace browser profile (OPERATOR_CDP_<PROFILE>)
  my_names       text[] not null default '{}',                                     -- how Julev appears in this client's chat
  rules          text not null default '',                                         -- client rules the drafter must follow
  viewer_url     text check (viewer_url is null or viewer_url ~ '^https://'),      -- live screen of this browser (basic auth)
  enabled        boolean not null default true,
  paused         boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger operator_clients_touch before update on operator_clients for each row execute function touch_updated_at();

-- ---------- channels ----------
create table operator_channels (
  id             uuid primary key default gen_random_uuid(),
  client_slug    text not null references operator_clients(slug) on delete cascade,
  kind           text not null check (kind in ('google_chat')),
  name           text not null,
  url            text not null check (url ~ '^https://chat\.google\.com/' or url ~ '^https://mail\.google\.com/chat/'),
  enabled        boolean not null default true,
  last_seen_key  text,                      -- newest message id already stored (poll cursor)
  last_polled_at timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  unique (client_slug, url)
);

-- ---------- autonomy ----------
-- action types: what a reply would DO. Classified per message by the drafter, then the strictest rule wins.
create table operator_autonomy (
  client_slug  text not null default '*',  -- '*' = default for every client
  action_type  text not null check (action_type in ('ack', 'status', 'thanks', 'factual', 'reply', 'task', 'publish',
                                                    'deadline', 'commitment', 'money', 'new_contact', 'delete', 'credentials')),
  mode         text not null check (mode in ('auto', 'approve', 'never')),
  updated_at   timestamptz not null default now(),
  primary key (client_slug, action_type)
);
-- Plan defaults: only acknowledgements, status updates and thank-yous may auto-send; credentials never; the rest asks.
insert into operator_autonomy (client_slug, action_type, mode) values
  ('*', 'ack', 'auto'), ('*', 'status', 'auto'), ('*', 'thanks', 'auto'),
  ('*', 'factual', 'approve'), ('*', 'reply', 'approve'), ('*', 'task', 'approve'), ('*', 'publish', 'approve'),
  ('*', 'deadline', 'approve'), ('*', 'commitment', 'approve'), ('*', 'money', 'approve'), ('*', 'new_contact', 'approve'),
  ('*', 'delete', 'approve'), ('*', 'credentials', 'never');

-- ---------- inbox ----------
create table operator_inbox (
  id             uuid primary key default gen_random_uuid(),
  client_slug    text not null references operator_clients(slug) on delete cascade,
  channel_id     uuid not null references operator_channels(id) on delete cascade,
  external_id    text not null check (length(external_id) between 1 and 300),
  thread_key     text,
  space_name     text,
  sender_name    text not null default '',
  body           text not null check (length(body) <= 20000),
  sent_at        timestamptz,
  url            text,
  mentions_me    boolean not null default false,
  from_me        boolean not null default false,
  status         text not null default 'new' check (status in ('new', 'classifying', 'fyi', 'drafted', 'approved', 'sending',
                                                               'sent', 'skipped', 'failed', 'blocked')),
  category       text check (category in ('fyi', 'reply', 'task')),
  action_type    text,
  confidence     numeric(4, 3),
  mode           text check (mode in ('auto', 'approve', 'never')),
  analysis       jsonb not null default '{}',   -- classifier output (summary, reasons, task plan, project used)
  draft          text,
  final_text     text,                          -- what was (or will be) sent: the draft, or the CEO's edited text
  approval_id    uuid references approvals(id) on delete set null,
  attempts       int not null default 0,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  handled_at     timestamptz,
  unique (channel_id, external_id)
);
create index operator_inbox_status on operator_inbox (status, created_at);
create index operator_inbox_client on operator_inbox (client_slug, created_at desc);
create trigger operator_inbox_touch before update on operator_inbox for each row execute function touch_updated_at();

-- ---------- audit log ----------
create table operator_actions (
  id           bigserial primary key,
  created_at   timestamptz not null default now(),
  client_slug  text,
  inbox_id     uuid references operator_inbox(id) on delete set null,
  actor        text not null check (actor in ('operator', 'ceo', 'system')),
  action       text not null check (action ~ '^[a-z_]+(\.[a-z_]+)*$'),
  ok           boolean not null default true,
  detail       jsonb not null default '{}',
  telegram_sent_at timestamptz             -- the bot's notice for auto-sends, failures and blocks (null = not sent / not needed)
);
create index operator_actions_recent on operator_actions (created_at desc);
create index operator_actions_notify on operator_actions (created_at) where telegram_sent_at is null
  and action in ('send.done', 'send.failed', 'send.blocked', 'message.classify_failed', 'watch.failed');
create index operator_actions_inbox on operator_actions (inbox_id);

-- ---------- RLS: the CEO reads, only the service role (operator / bot) writes ----------
do $$
declare t text;
begin
  foreach t in array array['operator_clients', 'operator_channels', 'operator_autonomy', 'operator_inbox', 'operator_actions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy ceo_read on %I for select to authenticated using (is_ceo())', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;
revoke all on sequence operator_actions_id_seq from anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'operator_actions') then
    alter publication supabase_realtime add table operator_actions, operator_inbox;
  end if;
end $$;

-- ---------- helpers ----------
create or replace function operator_log(p_actor text, p_action text, p_client text, p_inbox uuid, p_detail jsonb default '{}', p_ok boolean default true)
returns void language sql security definer set search_path = public as $$
  insert into operator_actions (actor, action, client_slug, inbox_id, detail, ok)
  values (p_actor, p_action, p_client, p_inbox, coalesce(p_detail, '{}'), coalesce(p_ok, true));
$$;

create or replace function operator_setting_on(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value in ('true'::jsonb, '"true"'::jsonb) from settings where key = p_key), false);
$$;

-- Why the operator may not send right now (null = it may). Kill switch, office pause, client pause/disabled.
create or replace function operator_send_blocker(p_client text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when operator_setting_on('operator_paused') then 'operator paused (kill switch)'
    when operator_setting_on('paused') then 'office paused'
    when not exists (select 1 from operator_clients where slug = p_client) then 'unknown client'
    when (select not enabled from operator_clients where slug = p_client) then 'client disabled'
    when (select paused from operator_clients where slug = p_client) then 'client paused'
    else null end;
$$;

-- The effective mode for a client + action type: the client's own row, else the default, else 'approve'.
create or replace function operator_mode_for(p_client text, p_action text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select mode from operator_autonomy where client_slug = p_client and action_type = p_action),
    (select mode from operator_autonomy where client_slug = '*' and action_type = p_action),
    'approve');
$$;

-- Kill switch (/pause on Telegram, Pause on /operator). Logged; returns the new state.
create or replace function operator_set_paused(p_paused boolean, p_via text default 'dashboard') returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  insert into settings (key, value) values ('operator_paused', to_jsonb(coalesce(p_paused, false)))
  on conflict (key) do update set value = excluded.value;
  -- Sends the worker already claimed fail closed: they re-check the blocker right before posting.
  perform operator_log('ceo', case when p_paused then 'operator.paused' else 'operator.resumed' end, null, null,
                       jsonb_build_object('via', coalesce(p_via, 'dashboard')));
  return coalesce(p_paused, false);
end $$;

create or replace function operator_set_client_paused(p_client text, p_paused boolean, p_via text default 'dashboard') returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  update operator_clients set paused = coalesce(p_paused, false) where slug = p_client;
  if not found then raise exception 'unknown client %', p_client; end if;
  perform operator_log('ceo', case when p_paused then 'client.paused' else 'client.resumed' end, p_client, null,
                       jsonb_build_object('via', coalesce(p_via, 'dashboard')));
  return coalesce(p_paused, false);
end $$;

-- ---------- the operator's state transitions (service role) ----------

-- Store a polled message once (idempotent on channel + external id). Returns the new id, or null when already seen.
create or replace function operator_ingest(p_channel uuid, p_msg jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare ch operator_channels; nid uuid;
begin
  perform hq_guard();
  select * into ch from operator_channels where id = p_channel;
  if ch.id is null then raise exception 'unknown channel'; end if;
  insert into operator_inbox (client_slug, channel_id, external_id, thread_key, space_name, sender_name, body, sent_at, url,
                              mentions_me, from_me, status)
  values (ch.client_slug, ch.id, p_msg ->> 'external_id', nullif(p_msg ->> 'thread_key', ''), nullif(p_msg ->> 'space_name', ''),
          coalesce(p_msg ->> 'sender_name', ''), left(coalesce(p_msg ->> 'body', ''), 20000), (p_msg ->> 'sent_at')::timestamptz,
          nullif(p_msg ->> 'url', ''), coalesce((p_msg ->> 'mentions_me')::boolean, false), coalesce((p_msg ->> 'from_me')::boolean, false),
          -- Julev's own messages are history (context for later drafts), never something to answer. So is the backlog seen
          -- on a channel's first poll (baseline): only messages that arrive after the operator started watching are answered.
          case when coalesce((p_msg ->> 'from_me')::boolean, false) or coalesce((p_msg ->> 'baseline')::boolean, false) then 'fyi' else 'new' end)
  on conflict (channel_id, external_id) do nothing
  returning id into nid;
  if nid is not null then
    perform operator_log('operator', 'message.new', ch.client_slug, nid,
                         jsonb_build_object('channel', ch.name, 'sender', p_msg ->> 'sender_name', 'from_me', coalesce((p_msg ->> 'from_me')::boolean, false),
                                            'baseline', coalesce((p_msg ->> 'baseline')::boolean, false)));
  end if;
  return nid;
end $$;

-- After each poll: move the cursor, stamp the time, keep the last error. A new error (or the first one after a good poll)
-- is logged once as watch.failed, so a broken login reaches Telegram once instead of every 2 minutes.
create or replace function operator_channel_polled(p_channel uuid, p_last_key text, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
declare ch operator_channels;
begin
  perform hq_guard();
  select * into ch from operator_channels where id = p_channel for update;
  if ch.id is null then raise exception 'unknown channel'; end if;
  update operator_channels set last_polled_at = now(), last_seen_key = coalesce(nullif(p_last_key, ''), last_seen_key),
                               last_error = left(nullif(p_error, ''), 1000)
   where id = ch.id;
  if nullif(p_error, '') is not null and ch.last_error is distinct from left(p_error, 1000) then
    perform operator_log('operator', 'watch.failed', ch.client_slug, null, jsonb_build_object('channel', ch.name, 'error', left(p_error, 300)), false);
  elsif nullif(p_error, '') is null and ch.last_error is not null then
    perform operator_log('operator', 'watch.recovered', ch.client_slug, null, jsonb_build_object('channel', ch.name));
  end if;
end $$;

-- Claim the next new message for classification (skip locked: safe with more than one operator process).
create or replace function operator_claim_new() returns operator_inbox
language plpgsql security definer set search_path = public as $$
declare r operator_inbox;
begin
  perform hq_guard();
  select * into r from operator_inbox
   where status = 'new' or (status = 'classifying' and updated_at < now() - interval '10 minutes')
   order by created_at limit 1 for update skip locked;
  if r.id is null then return null; end if;
  update operator_inbox set status = 'classifying', attempts = attempts + 1 where id = r.id returning * into r;
  return r;
end $$;

-- Store the classifier's verdict + draft and decide what happens next (all in SQL, so the rules can't be skipped):
--   fyi                                   → status fyi, nothing sent
--   mode never                            → blocked (logged), nothing sent
--   mode auto + operator_auto_send on     → approved (the worker sends it after operator_claim_send)
--   otherwise                             → drafted + an approval for the CEO (Telegram: Send / Edit / Skip)
-- The strictest of the classifier's action types wins; low confidence (< 0.75) always asks.
create or replace function operator_record_draft(p_inbox uuid, p_result jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare r operator_inbox; c operator_clients; ch operator_channels;
        cat text := p_result ->> 'category'; conf numeric := coalesce((p_result ->> 'confidence')::numeric, 0);
        v_draft text := nullif(btrim(coalesce(p_result ->> 'draft', '')), ''); types text[]; t text; m text; eff text := 'auto';
        aid uuid; outcome text;
begin
  perform hq_guard();
  select * into r from operator_inbox where id = p_inbox for update;
  if r.id is null then raise exception 'unknown inbox row'; end if;
  if r.status <> 'classifying' then return 'not_classifying'; end if;
  if cat not in ('fyi', 'reply', 'task') then raise exception 'bad category %', cat; end if;
  select * into c from operator_clients where slug = r.client_slug;
  select * into ch from operator_channels where id = r.channel_id;

  select coalesce(array_agg(distinct x), '{}') into types
    from jsonb_array_elements_text(coalesce(p_result -> 'action_types', '[]')) x
   where x in (select action_type from operator_autonomy);
  if cat = 'task' and not ('task' = any (types)) then types := array_append(types, 'task'); end if;
  if cat = 'reply' and cardinality(types) = 0 then types := array['reply']; end if;

  if cat = 'fyi' or v_draft is null then
    update operator_inbox set status = 'fyi', category = cat, confidence = conf, analysis = p_result - 'draft',
                              handled_at = now(), error = null where id = r.id;
    perform operator_log('operator', 'message.classified', r.client_slug, r.id, jsonb_build_object('category', cat, 'confidence', conf));
    return 'fyi';
  end if;

  foreach t in array types loop
    m := operator_mode_for(r.client_slug, t);
    if m = 'never' then eff := 'never';
    elsif m = 'approve' and eff <> 'never' then eff := 'approve';
    end if;
  end loop;
  if eff = 'auto' and (conf < 0.75 or not operator_setting_on('operator_auto_send')) then eff := 'approve'; end if;

  update operator_inbox set category = cat, action_type = array_to_string(types, ','), confidence = conf, mode = eff,
                            analysis = p_result - 'draft', draft = v_draft, error = null where id = r.id;
  perform operator_log('operator', 'message.classified', r.client_slug, r.id,
                       jsonb_build_object('category', cat, 'action_types', to_jsonb(types), 'confidence', conf, 'mode', eff));

  if eff = 'never' then
    update operator_inbox set status = 'blocked', handled_at = now() where id = r.id;
    perform operator_log('operator', 'send.blocked', r.client_slug, r.id, jsonb_build_object('reason', 'autonomy rule: never', 'action_types', to_jsonb(types)), false);
    outcome := 'blocked';
  elsif eff = 'auto' then
    update operator_inbox set status = 'approved', final_text = v_draft where id = r.id;
    perform operator_log('operator', 'send.auto_approved', r.client_slug, r.id, jsonb_build_object('action_types', to_jsonb(types)));
    outcome := 'auto';
  else
    insert into approvals (kind, title, summary, payload)
    values ('external_action',
            left('Reply to ' || coalesce(nullif(r.sender_name, ''), 'chat') || ' (' || c.name || ')', 200),
            v_draft,
            jsonb_build_object('type', 'operator_reply', 'inbox_id', r.id, 'client', c.slug, 'client_name', c.name,
                               'channel', ch.name, 'space', r.space_name, 'sender', r.sender_name, 'message', left(r.body, 1500),
                               'message_url', r.url, 'draft', v_draft, 'category', cat, 'action_types', to_jsonb(types),
                               'confidence', conf, 'summary', p_result ->> 'summary', 'task_plan', p_result -> 'task_plan',
                               'project', p_result ->> 'project'))
    returning id into aid;
    update operator_inbox set status = 'drafted', approval_id = aid where id = r.id;
    perform operator_log('operator', 'approval.requested', r.client_slug, r.id, jsonb_build_object('approval_id', aid));
    outcome := 'approval';
  end if;
  return outcome;
end $$;

-- A classification failed: back to new (retried) or failed after 3 attempts.
create or replace function operator_classify_failed(p_inbox uuid, p_error text) returns text
language plpgsql security definer set search_path = public as $$
declare r operator_inbox;
begin
  perform hq_guard();
  update operator_inbox set status = case when attempts >= 3 then 'failed' else 'new' end, error = left(p_error, 1000)
   where id = p_inbox and status = 'classifying' returning * into r;
  if r.id is null then return 'not_classifying'; end if;
  perform operator_log('operator', 'message.classify_failed', r.client_slug, r.id, jsonb_build_object('error', left(p_error, 300), 'attempts', r.attempts), false);
  return r.status;
end $$;

-- The CEO's decision flows to the inbox row: ✅ Send → approved (draft), ✏️ Edit → approved with the CEO's text,
-- ❌ Skip → skipped. The worker then sends approved rows (through operator_claim_send).
create or replace function operator_on_decision() returns trigger
language plpgsql security definer set search_path = public as $$
declare r operator_inbox;
begin
  if coalesce(new.payload ->> 'type', '') = 'operator_reply' and old.status = 'pending' and new.status <> 'pending' then
    select * into r from operator_inbox where id = (new.payload ->> 'inbox_id')::uuid and status = 'drafted' for update;
    if r.id is null then return new; end if;
    if new.status = 'approved' then
      update operator_inbox set status = 'approved', final_text = r.draft where id = r.id;
    elsif new.status = 'changes_requested' and nullif(btrim(coalesce(new.ceo_note, '')), '') is not null then
      update operator_inbox set status = 'approved', final_text = btrim(new.ceo_note) where id = r.id;
    else
      update operator_inbox set status = 'skipped', handled_at = now() where id = r.id;
    end if;
    perform operator_log('ceo', case new.status when 'approved' then 'reply.approved' when 'changes_requested' then 'reply.edited' else 'reply.skipped' end,
                         r.client_slug, r.id, jsonb_build_object('approval_id', new.id, 'via', new.decided_via));
  end if;
  return new;
end $$;
create trigger operator_reply_decided after update of status on approvals for each row execute function operator_on_decision();

-- Claim an approved reply for sending. Refuses (returns null, logs why) while any pause is on: the kill switch.
-- A send interrupted for 10+ minutes (worker crash after Enter?) is never retried: it may already be posted.
create or replace function operator_claim_send() returns operator_inbox
language plpgsql security definer set search_path = public as $$
declare r operator_inbox; why text;
begin
  perform hq_guard();
  for r in update operator_inbox set status = 'failed', handled_at = now(),
                  error = 'interrupted while sending: check the chat before sending again'
            where status = 'sending' and updated_at < now() - interval '10 minutes' returning * loop
    perform operator_log('operator', 'send.failed', r.client_slug, r.id, jsonb_build_object('error', r.error), false);
  end loop;
  for r in select * from operator_inbox
            where status = 'approved'
            order by updated_at limit 20 for update skip locked loop
    why := operator_send_blocker(r.client_slug);
    if why is null then
      update operator_inbox set status = 'sending', attempts = attempts + 1 where id = r.id returning * into r;
      return r;
    end if;
  end loop;
  return null;
end $$;

-- Right before posting, the worker asks once more (a /pause that lands mid-send stops it here).
create or replace function operator_may_send(p_inbox uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(operator_send_blocker(r.client_slug), case when r.status = 'sending' then null else 'not claimed' end)
    from operator_inbox r where r.id = p_inbox;
$$;

-- p_final: never retry (the reply may have been posted, or the failure needs a person).
create or replace function operator_send_done(p_inbox uuid, p_ok boolean, p_error text default null, p_detail jsonb default '{}',
                                              p_final boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare r operator_inbox;
begin
  perform hq_guard();
  if p_ok then
    update operator_inbox set status = 'sent', handled_at = now(), error = null where id = p_inbox and status = 'sending' returning * into r;
  else
    update operator_inbox set status = case when attempts >= 3 or coalesce(p_final, false) then 'failed' else 'approved' end,
                              error = left(coalesce(p_error, 'send failed'), 1000),
                              handled_at = case when attempts >= 3 or coalesce(p_final, false) then now() end
     where id = p_inbox and status = 'sending' returning * into r;
  end if;
  if r.id is null then return 'not_sending'; end if;
  perform operator_log('operator', case when p_ok then 'send.done' when r.status = 'failed' then 'send.failed' else 'send.retry' end,
                       r.client_slug, r.id, coalesce(p_detail, '{}') || jsonb_build_object('mode', r.mode, 'error', left(p_error, 300)), p_ok);
  return r.status;
end $$;

-- Operator page / Telegram /status <client>: counts per state plus the newest rows.
create or replace function operator_client_status(p_client text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c operator_clients;
begin
  perform hq_guard();
  select * into c from operator_clients where slug = p_client;
  if c.slug is null then return null; end if;
  return jsonb_build_object(
    'client', to_jsonb(c) - 'rules',
    'blocker', operator_send_blocker(c.slug),
    'auto_send', operator_setting_on('operator_auto_send'),
    'counts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from operator_inbox
                          where client_slug = c.slug and created_at > now() - interval '7 days' group by status) s), '{}'),
    'channels', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'enabled', enabled, 'last_polled_at', last_polled_at, 'last_error', last_error) order by name)
                            from operator_channels where client_slug = c.slug), '[]'),
    'last_action', (select jsonb_build_object('action', action, 'at', created_at, 'ok', ok) from operator_actions
                     where client_slug = c.slug order by id desc limit 1));
end $$;

-- ---------- CEO: watched chats and the live-screen link (/operator) ----------
create or replace function operator_add_channel(p_client text, p_name text, p_url text) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid; n text := left(btrim(coalesce(p_name, '')), 120); u text := btrim(coalesce(p_url, ''));
begin
  perform hq_guard();
  if not exists (select 1 from operator_clients where slug = p_client) then raise exception 'unknown client %', p_client; end if;
  if n = '' then raise exception 'give the chat a name'; end if;
  if u !~ '^https://chat\.google\.com/' and u !~ '^https://mail\.google\.com/chat/' then
    raise exception 'paste the chat''s address from chat.google.com (or mail.google.com/chat)';
  end if;
  insert into operator_channels (client_slug, kind, name, url) values (p_client, 'google_chat', n, u)
  on conflict (client_slug, url) do update set name = excluded.name, enabled = true
  returning id into cid;
  perform operator_log('ceo', 'channel.added', p_client, null, jsonb_build_object('channel', n));
  return cid;
end $$;

create or replace function operator_set_channel_enabled(p_channel uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare ch operator_channels;
begin
  perform hq_guard();
  update operator_channels set enabled = coalesce(p_enabled, false) where id = p_channel returning * into ch;
  if ch.id is null then raise exception 'unknown chat'; end if;
  perform operator_log('ceo', case when ch.enabled then 'channel.enabled' else 'channel.disabled' end, ch.client_slug, null, jsonb_build_object('channel', ch.name));
  return ch.enabled;
end $$;

create or replace function operator_set_viewer_url(p_client text, p_url text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := nullif(btrim(coalesce(p_url, '')), '');
begin
  perform hq_guard();
  if u is not null and u !~ '^https://[^\s]+$' then raise exception 'the live screen address must start with https://'; end if;
  update operator_clients set viewer_url = u where slug = p_client;
  if not found then raise exception 'unknown client %', p_client; end if;
end $$;

-- ---------- grants: everything above is service-only, except the pause switches and the status read (CEO too) ----------
do $$
declare f text;
begin
  foreach f in array array['operator_log(text,text,text,uuid,jsonb,boolean)', 'operator_setting_on(text)', 'operator_send_blocker(text)',
                           'operator_mode_for(text,text)', 'operator_ingest(uuid,jsonb)', 'operator_channel_polled(uuid,text,text)', 'operator_claim_new()',
                           'operator_record_draft(uuid,jsonb)', 'operator_classify_failed(uuid,text)', 'operator_claim_send()',
                           'operator_may_send(uuid)', 'operator_send_done(uuid,boolean,text,jsonb,boolean)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['operator_set_paused(boolean,text)', 'operator_set_client_paused(text,boolean,text)', 'operator_client_status(text)',
                           'operator_add_channel(text,text,text)', 'operator_set_channel_enabled(uuid,boolean)', 'operator_set_viewer_url(text,text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
revoke execute on function operator_on_decision() from public, anon, authenticated;
grant execute on function operator_on_decision() to service_role;

-- ---------- first client: LvlUp Ventures (Google Chat). Channels are added on /operator or by SQL once the profile is
-- logged in; nothing is watched until then. Rules from the vault (projects/lvlup-ventures/memory.md). ----------
insert into operator_clients (slug, name, client_id, brain_project, profile, my_names, rules)
values ('lvlup', 'LvlUp Ventures', (select id from clients where slug in ('lvlup', 'lvlup-ventures') order by slug limit 1),
        'lvlup-ventures', 'lvlup', array['Julev', 'Julev Ajeto'],
        E'- Never share financial figures (fund sizes, valuations, revenue, portfolio numbers) unless the client has opted them in for that use.\n'
        '- Never share logins, passwords, API keys or tokens, and never say whose account a tool is logged into.\n'
        '- Do not promise publish dates, deadlines or new work: draft them for Julev to approve.\n'
        '- After a request is done, partly done or blocked, reply in the same thread with the status and the live or preview link.\n'
        '- Who decides, and who approves numbers or public text, is in the project memory (Contacts): follow it.\n'
        '- Tone: short, friendly, professional; first person as Julev; no emojis unless the thread uses them.')
on conflict (slug) do nothing;
