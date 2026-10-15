-- Julev Operator phase 3, milestone 4 (docs/17-OPERATOR.md "More channels"): watch Gmail, Slack and Teams in the
-- client's workspace browser, like Google Chat: read, classify, draft with the project memory, through the same tiers.
-- The operator only POSTS where it has a tested sender (Google Chat; WhatsApp Business comes with its own milestone).
-- An approved (or auto-cleared) reply on a read-only channel becomes 'manual': nothing is typed anywhere, Telegram gets
-- "📋 Post this yourself" with the exact text and a link, and the row says so on /operator. Same for job client updates.

-- ---------- channels ----------
alter table operator_channels drop constraint if exists operator_channels_kind_check;
alter table operator_channels add constraint operator_channels_kind_check check (kind in ('google_chat', 'gmail', 'slack', 'teams'));

-- The address rules per kind (what the watcher can open in the client's browser).
create or replace function operator_channel_url_ok(p_kind text, p_url text) returns boolean
language sql immutable set search_path = public as $$
  select case p_kind
    when 'google_chat' then p_url ~ '^https://chat\.google\.com/' or p_url ~ '^https://mail\.google\.com/chat/'
    when 'gmail' then p_url ~ '^https://mail\.google\.com/mail/'
    when 'slack' then p_url ~ '^https://app\.slack\.com/client/' or p_url ~ '^https://[a-z0-9-]+\.slack\.com/(archives|messages)/'
    when 'teams' then p_url ~ '^https://teams\.(microsoft|live|cloud\.microsoft)\.com/' or p_url ~ '^https://teams\.cloud\.microsoft/'
    else false end;
$$;
alter table operator_channels drop constraint if exists operator_channels_url_check;
alter table operator_channels add constraint operator_channels_url_check check (operator_channel_url_ok(kind, url));

-- Kinds the operator posts in itself. Everything else is read + draft; approved text is posted by the CEO.
create or replace function operator_channel_sends(p_kind text) returns boolean
language sql immutable set search_path = public as $$
  select p_kind in ('google_chat');
$$;

-- ---------- 'manual': approved, to be posted by the CEO ----------
alter table operator_inbox drop constraint if exists operator_inbox_status_check;
alter table operator_inbox add constraint operator_inbox_status_check
  check (status in ('new', 'classifying', 'fyi', 'drafted', 'approved', 'sending', 'sent', 'skipped', 'failed', 'blocked', 'manual'));
alter table operator_outbox drop constraint if exists operator_outbox_status_check;
alter table operator_outbox add constraint operator_outbox_status_check
  check (status in ('drafted', 'approved', 'sending', 'sent', 'skipped', 'failed', 'blocked', 'manual'));

drop index if exists operator_actions_notify;
create index operator_actions_notify on operator_actions (created_at) where telegram_sent_at is null
  and action in ('send.done', 'send.failed', 'send.blocked', 'message.classify_failed', 'watch.failed',
                 'update.done', 'update.failed', 'update.blocked', 'job.started', 'job.done', 'job.escalated', 'job.failed',
                 'action.done', 'action.failed', 'login.lost', 'login.restored', 'reply.manual', 'update.manual');

-- Next reply to post. Approved replies on read-only channels are handed to the CEO here (one place for the decision,
-- the edit and the auto path), so the browser sender only ever sees channels it can post in.
create or replace function operator_claim_send() returns operator_inbox
language plpgsql security definer set search_path = public as $$
declare r operator_inbox; why text; ch operator_channels;
begin
  perform hq_guard();
  for r in update operator_inbox set status = 'failed', handled_at = now(),
                  error = 'interrupted while sending: check the chat before sending again'
            where status = 'sending' and updated_at < now() - interval '10 minutes' returning * loop
    perform operator_log('operator', 'send.failed', r.client_slug, r.id, jsonb_build_object('error', r.error), false);
  end loop;
  for r in update operator_inbox i set status = 'manual', handled_at = now(), final_text = coalesce(i.final_text, i.draft)
             from operator_channels c
            where c.id = i.channel_id and i.status = 'approved' and not operator_channel_sends(c.kind)
            returning i.* loop
    select * into ch from operator_channels where id = r.channel_id;
    perform operator_log('operator', 'reply.manual', r.client_slug, r.id,
                         jsonb_build_object('kind', ch.kind, 'channel', ch.name, 'url', coalesce(r.url, ch.url), 'sender', r.sender_name,
                                            'text', left(r.final_text, 3000), 'mode', r.mode));
  end loop;
  for r in select i.* from operator_inbox i join operator_channels c on c.id = i.channel_id
            where i.status = 'approved' and operator_channel_sends(c.kind)
            order by i.updated_at limit 20 for update of i skip locked loop
    why := operator_send_blocker(r.client_slug);
    if why is null then
      update operator_inbox set status = 'sending', attempts = attempts + 1 where id = r.id returning * into r;
      return r;
    end if;
  end loop;
  return null;
end $$;

create or replace function operator_claim_update() returns operator_outbox
language plpgsql security definer set search_path = public as $$
declare o operator_outbox; ch operator_channels;
begin
  perform hq_guard();
  for o in update operator_outbox set status = 'failed', handled_at = now(), error = 'interrupted while sending: check the chat before sending again'
            where status = 'sending' and updated_at < now() - interval '10 minutes' returning * loop
    perform operator_log_job('operator', 'update.failed', o.client_slug, o.job_id, jsonb_build_object('outbox_id', o.id, 'error', o.error), false);
  end loop;
  for o in update operator_outbox x set status = 'manual', handled_at = now()
             from operator_channels c
            where c.id = x.channel_id and x.status = 'approved' and not operator_channel_sends(c.kind)
            returning x.* loop
    select * into ch from operator_channels where id = o.channel_id;
    perform operator_log_job('operator', 'update.manual', o.client_slug, o.job_id,
                             jsonb_build_object('outbox_id', o.id, 'kind', ch.kind, 'channel', ch.name, 'url', ch.url, 'text', left(o.final_text, 3000)));
  end loop;
  for o in select x.* from operator_outbox x join operator_channels c on c.id = x.channel_id
            where x.status = 'approved' and operator_channel_sends(c.kind)
            order by x.updated_at limit 20 for update of x skip locked loop
    if operator_send_blocker(o.client_slug) is null then
      update operator_outbox set status = 'sending', attempts = attempts + 1 where id = o.id returning * into o;
      return o;
    end if;
  end loop;
  return null;
end $$;

-- The CEO adds a channel of any kind (Google Chat keeps operator_add_channel).
create or replace function operator_add_watch(p_client text, p_kind text, p_name text, p_url text) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid; n text := left(btrim(coalesce(p_name, '')), 120); u text := btrim(coalesce(p_url, ''));
begin
  perform hq_guard();
  if not exists (select 1 from operator_clients where slug = p_client) then raise exception 'unknown client %', p_client; end if;
  if p_kind not in ('google_chat', 'gmail', 'slack', 'teams') then raise exception 'unknown channel kind %', p_kind; end if;
  if n = '' then raise exception 'give it a name'; end if;
  if not operator_channel_url_ok(p_kind, u) then
    raise exception '%', case p_kind
      when 'gmail' then 'paste a Gmail address (https://mail.google.com/mail/u/0/#label/… or #search/…)'
      when 'slack' then 'paste the Slack channel address (https://app.slack.com/client/…)'
      when 'teams' then 'paste the Teams chat or channel address (https://teams.microsoft.com/…)'
      else 'paste the chat''s address from chat.google.com' end;
  end if;
  insert into operator_channels (client_slug, kind, name, url) values (p_client, p_kind, n, u)
  on conflict (client_slug, url) do update set name = excluded.name, kind = excluded.kind, enabled = true
  returning id into cid;
  perform operator_log('ceo', 'channel.added', p_client, null, jsonb_build_object('channel', n, 'kind', p_kind));
  return cid;
end $$;

do $$
declare f text;
begin
  foreach f in array array['operator_channel_url_ok(text,text)', 'operator_channel_sends(text)', 'operator_claim_send()', 'operator_claim_update()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  execute 'revoke execute on function operator_add_watch(text,text,text,text) from public, anon';
  execute 'grant execute on function operator_add_watch(text,text,text,text) to authenticated, service_role';
end $$;
