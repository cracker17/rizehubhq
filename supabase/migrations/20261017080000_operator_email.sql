-- Julev Operator phase 3, milestone 8 (docs/17-OPERATOR.md "Email: senders, summary, /open"): for Gmail the CEO names
-- the senders that matter (an address, a whole @domain, or a name); mail from anyone else is not stored at all.
-- email_mode per client:
--   'pick' (default)  targeted unread mail waits as 'held' with a short number; the operator sends a Telegram summary
--                     (who, subject); "/open 2" or the Open button turns that email into a normal message: drafted in
--                     Julev's voice with the project memory, then ✅ Send / ✏️ Edit like any reply
--   'auto'            targeted mail is drafted right away (phase 3 behaviour)

alter table operator_inbox drop constraint if exists operator_inbox_status_check;
alter table operator_inbox add constraint operator_inbox_status_check
  check (status in ('new', 'classifying', 'fyi', 'drafted', 'approved', 'sending', 'sent', 'skipped', 'failed', 'blocked', 'manual', 'held'));
alter table operator_inbox add column if not exists sender_email text;
alter table operator_inbox add column if not exists pick_no int;
alter table operator_inbox add column if not exists summarized_at timestamptz;
alter table operator_inbox add column if not exists opened_at timestamptz;
create index if not exists operator_inbox_held on operator_inbox (client_slug, pick_no) where status = 'held';

alter table operator_clients add column if not exists email_mode text not null default 'pick' check (email_mode in ('pick', 'auto'));
alter table operator_clients add column if not exists email_pick_seq int not null default 0;

create table operator_email_targets (
  client_slug  text not null references operator_clients(slug) on delete cascade,
  pattern      text not null check (length(pattern) between 2 and 200 and pattern = lower(pattern)),
  created_at   timestamptz not null default now(),
  primary key (client_slug, pattern)
);
alter table operator_email_targets enable row level security;
create policy ceo_read on operator_email_targets for select to authenticated using (is_ceo());
revoke all on operator_email_targets from anon, authenticated;
grant select on operator_email_targets to authenticated;

insert into settings (key, value) values ('operator_email_summary_minutes', '15'::jsonb) on conflict (key) do nothing;

-- Does this sender count? No targets = everyone (unchanged behaviour). "@lvlup.vc" = that domain, "alex@lvlup.vc" = that
-- address, anything else = a name (or part of the address).
create or replace function operator_email_match(p_client text, p_name text, p_email text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from operator_email_targets where client_slug = p_client)
      or exists (select 1 from operator_email_targets t where t.client_slug = p_client and (
            (t.pattern like '@%' and lower(coalesce(p_email, '')) like '%' || t.pattern)
         or (t.pattern like '%_@_%' and lower(coalesce(p_email, '')) = t.pattern)
         or (t.pattern not like '%@%' and (lower(coalesce(p_name, '')) like '%' || t.pattern || '%' or lower(coalesce(p_email, '')) like '%' || t.pattern || '%'))));
$$;

-- operator_ingest of 20261015000000_operator.sql, with the email rules: Gmail mail from non-targets is dropped (never
-- stored), targeted mail in 'pick' mode waits as 'held' with the client's next pick number; sender_email is kept.
create or replace function operator_ingest(p_channel uuid, p_msg jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare ch operator_channels; nid uuid; c operator_clients; st text; pick int;
        own boolean := coalesce((p_msg ->> 'from_me')::boolean, false); base boolean := coalesce((p_msg ->> 'baseline')::boolean, false);
begin
  perform hq_guard();
  select * into ch from operator_channels where id = p_channel;
  if ch.id is null then raise exception 'unknown channel'; end if;
  st := case when own or base then 'fyi' else 'new' end;
  if ch.kind = 'gmail' and not own then
    if not operator_email_match(ch.client_slug, p_msg ->> 'sender_name', p_msg ->> 'sender_email') then return null; end if;
    select * into c from operator_clients where slug = ch.client_slug;
    if st = 'new' and c.email_mode = 'pick' then st := 'held'; end if;
  end if;
  if exists (select 1 from operator_inbox where channel_id = ch.id and external_id = p_msg ->> 'external_id') then return null; end if;
  if st = 'held' then
    update operator_clients set email_pick_seq = case when email_pick_seq >= 99 then 1 else email_pick_seq + 1 end
     where slug = ch.client_slug returning email_pick_seq into pick;
    update operator_inbox set pick_no = null where client_slug = ch.client_slug and pick_no = pick; -- numbers are reused after 99
  end if;
  insert into operator_inbox (client_slug, channel_id, external_id, thread_key, space_name, sender_name, sender_email, body, sent_at, url,
                              mentions_me, from_me, status, pick_no)
  values (ch.client_slug, ch.id, p_msg ->> 'external_id', nullif(p_msg ->> 'thread_key', ''), nullif(p_msg ->> 'space_name', ''),
          coalesce(p_msg ->> 'sender_name', ''), nullif(left(lower(btrim(coalesce(p_msg ->> 'sender_email', ''))), 200), ''),
          left(coalesce(p_msg ->> 'body', ''), 20000), (p_msg ->> 'sent_at')::timestamptz,
          nullif(p_msg ->> 'url', ''), coalesce((p_msg ->> 'mentions_me')::boolean, false), own, st, pick)
  on conflict (channel_id, external_id) do nothing
  returning id into nid;
  if nid is not null then
    perform operator_log('operator', case when st = 'held' then 'email.held' else 'message.new' end, ch.client_slug, nid,
                         jsonb_build_object('channel', ch.name, 'sender', p_msg ->> 'sender_name', 'from_me', own, 'baseline', base, 'pick', pick));
  end if;
  return nid;
end $$;

-- The "addressed to Julev" wrapper of 20261017040000_operator_discovery.sql: an email Julev opened himself always is.
create or replace function operator_record_draft(p_inbox uuid, p_result jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare r operator_inbox; c operator_clients; ch operator_channels; addressed boolean; res jsonb := p_result;
begin
  perform hq_guard();
  select * into r from operator_inbox where id = p_inbox;
  if r.id is not null and coalesce(p_result ->> 'category', '') in ('reply', 'task') then
    select * into c from operator_clients where slug = r.client_slug;
    select * into ch from operator_channels where id = r.channel_id;
    addressed := ch.direct or ch.kind = 'whatsapp' or r.mentions_me or r.opened_at is not null
                 or coalesce((p_result ->> 'addressed_to_julev')::boolean, false);
    if coalesce(c.reply_when, 'addressed') = 'addressed' and not addressed then
      res := p_result || jsonb_build_object('category', 'fyi', 'draft', '', 'not_addressed', true, 'drafted_category', p_result ->> 'category');
    end if;
  end if;
  return operator_record_draft_tiers(p_inbox, res);
end $$;

-- Every minute (operator): one Telegram summary per client of the held mail not summarized yet, once the oldest has
-- waited operator_email_summary_minutes (default 15) or 5 are waiting. Returns how many summaries were written.
create or replace function operator_email_summary_tick(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = public as $$
declare mins int := coalesce((select (value #>> '{}')::int from settings where key = 'operator_email_summary_minutes'), 15);
        cl record; items jsonb; n int := 0;
begin
  perform hq_guard();
  for cl in select client_slug, count(*) cnt, min(created_at) oldest from operator_inbox
             where status = 'held' and summarized_at is null group by client_slug loop
    if cl.cnt < 5 and cl.oldest > p_now - make_interval(mins => greatest(mins, 1)) then continue; end if;
    select jsonb_agg(jsonb_build_object('inbox_id', id, 'n', pick_no, 'sender', sender_name, 'email', sender_email,
                                        'subject', left(regexp_replace(body, '\s+', ' ', 'g'), 160), 'url', url) order by pick_no)
      into items from operator_inbox where client_slug = cl.client_slug and status = 'held' and summarized_at is null;
    update operator_inbox set summarized_at = p_now where client_slug = cl.client_slug and status = 'held' and summarized_at is null;
    perform operator_log('operator', 'email.summary', cl.client_slug, null, jsonb_build_object('items', items, 'count', cl.cnt));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- CEO (Telegram / dashboard) ----------
create or replace function operator_open_email(p_inbox uuid, p_via text default 'telegram') returns text
language plpgsql security definer set search_path = public as $$
declare r operator_inbox;
begin
  perform hq_guard();
  update operator_inbox set status = 'new', opened_at = now() where id = p_inbox and status = 'held' returning * into r;
  if r.id is null then
    return coalesce((select 'already_' || status from operator_inbox where id = p_inbox), 'unknown');
  end if;
  perform operator_log('ceo', 'email.opened', r.client_slug, r.id, jsonb_build_object('via', coalesce(p_via, 'telegram'), 'sender', r.sender_name, 'n', r.pick_no));
  return 'opened';
end $$;

-- "/open 2" (or "/open lvlup 2"): the held email with that number; without a client, only when exactly one has it.
create or replace function operator_open_pick(p_client text, p_no int, p_via text default 'telegram') returns jsonb
language plpgsql security definer set search_path = public as $$
declare ids uuid[]; r operator_inbox;
begin
  perform hq_guard();
  select array_agg(id order by created_at desc) into ids from operator_inbox
   where status = 'held' and pick_no = p_no and (p_client is null or client_slug = p_client);
  if coalesce(cardinality(ids), 0) = 0 then return jsonb_build_object('result', 'not_found'); end if;
  if p_client is null and (select count(distinct client_slug) from operator_inbox where id = any (ids)) > 1 then
    return jsonb_build_object('result', 'ambiguous', 'clients', (select jsonb_agg(distinct client_slug) from operator_inbox where id = any (ids)));
  end if;
  select * into r from operator_inbox where id = ids[1];
  perform operator_open_email(r.id, p_via);
  return jsonb_build_object('result', 'opened', 'client', r.client_slug, 'sender', r.sender_name, 'subject', left(r.body, 120));
end $$;

create or replace function operator_dismiss_email(p_inbox uuid, p_via text default 'telegram') returns text
language plpgsql security definer set search_path = public as $$
declare r operator_inbox;
begin
  perform hq_guard();
  update operator_inbox set status = 'skipped', handled_at = now() where id = p_inbox and status = 'held' returning * into r;
  if r.id is null then return 'not_held'; end if;
  perform operator_log('ceo', 'email.dismissed', r.client_slug, r.id, jsonb_build_object('via', coalesce(p_via, 'telegram')));
  return 'dismissed';
end $$;

-- The senders to watch (replaces the list; empty = everyone) and the mode.
create or replace function operator_set_email_targets(p_client text, p_patterns text[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform hq_guard();
  if not exists (select 1 from operator_clients where slug = p_client) then raise exception 'unknown client %', p_client; end if;
  delete from operator_email_targets where client_slug = p_client;
  insert into operator_email_targets (client_slug, pattern)
  select distinct p_client, lower(btrim(x)) from unnest(coalesce(p_patterns, '{}')) x where length(btrim(x)) between 2 and 200
  on conflict do nothing;
  get diagnostics n = row_count;
  if (select count(*) from operator_email_targets where client_slug = p_client) > 100 then raise exception 'at most 100 senders'; end if;
  perform operator_log('ceo', 'email.targets', p_client, null, jsonb_build_object('count', n));
  return n;
end $$;

create or replace function operator_set_email_mode(p_client text, p_mode text) returns text
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  if p_mode not in ('pick', 'auto') then raise exception 'email mode must be pick or auto'; end if;
  update operator_clients set email_mode = p_mode where slug = p_client;
  if not found then raise exception 'unknown client %', p_client; end if;
  return p_mode;
end $$;

drop index if exists operator_actions_notify;
create index operator_actions_notify on operator_actions (created_at) where telegram_sent_at is null
  and action in ('send.done', 'send.failed', 'send.blocked', 'message.classify_failed', 'watch.failed',
                 'update.done', 'update.failed', 'update.blocked', 'job.started', 'job.done', 'job.escalated', 'job.failed',
                 'action.done', 'action.failed', 'login.lost', 'login.restored', 'reply.manual', 'update.manual', 'posting.tested',
                 'email.summary', 'ai.fallback', 'ai.restored');

do $$
declare f text;
begin
  foreach f in array array['operator_email_match(text,text,text)', 'operator_ingest(uuid,jsonb)', 'operator_record_draft(uuid,jsonb)',
                           'operator_email_summary_tick(timestamptz)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['operator_open_email(uuid,text)', 'operator_open_pick(text,int,text)', 'operator_dismiss_email(uuid,text)',
                           'operator_set_email_targets(text,text[])', 'operator_set_email_mode(text,text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
