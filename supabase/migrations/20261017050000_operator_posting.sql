-- Julev Operator phase 3, milestone 6b (docs/17-OPERATOR.md "Posting in Slack, Teams and Gmail"): the operator may
-- post its approved replies in Slack / Teams / Gmail for a client only after that app passed a send test on that
-- client's browser, and only while the CEO has posting switched on. Until then those replies stay 'manual'.
--   send test: the CEO names a test conversation (a DM to himself / a test channel); the operator types a short test
--              message there with the same composer checks as a real reply, sends it, and reads it back
--   posting:   on only with a passed test from the last 30 days (operator_set_posting refuses otherwise)

create table operator_posting (
  client_slug   text not null references operator_clients(slug) on delete cascade,
  kind          text not null check (kind in ('gmail', 'slack', 'teams')),
  test_url      text,
  test_state    text not null default 'none' check (test_state in ('none', 'requested', 'running', 'passed', 'failed')),
  test_detail   text,
  tested_at     timestamptz,
  enabled       boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (client_slug, kind)
);
alter table operator_posting enable row level security;
create policy ceo_read on operator_posting for select to authenticated using (is_ceo());
revoke all on operator_posting from anon, authenticated;
grant select on operator_posting to authenticated;

-- Does the operator post in this client's channel of this kind? Google Chat and WhatsApp always (their own rules);
-- Slack / Teams / Gmail only with posting on and a passed test.
create or replace function operator_channel_posts(p_client text, p_kind text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_kind in ('google_chat', 'whatsapp')
      or exists (select 1 from operator_posting p where p.client_slug = p_client and p.kind = p_kind and p.enabled
                   and p.test_state = 'passed' and p.tested_at > now() - interval '30 days');
$$;

-- The claim functions of 20261017020000_operator_watchers.sql, now per client (operator_channel_posts).
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
            where c.id = i.channel_id and i.status = 'approved' and not operator_channel_posts(c.client_slug, c.kind)
            returning i.* loop
    select * into ch from operator_channels where id = r.channel_id;
    perform operator_log('operator', 'reply.manual', r.client_slug, r.id,
                         jsonb_build_object('kind', ch.kind, 'channel', ch.name, 'url', coalesce(r.url, ch.url), 'sender', r.sender_name,
                                            'text', left(r.final_text, 3000), 'mode', r.mode));
  end loop;
  for r in select i.* from operator_inbox i join operator_channels c on c.id = i.channel_id
            where i.status = 'approved' and operator_channel_posts(c.client_slug, c.kind)
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
            where c.id = x.channel_id and x.status = 'approved' and not operator_channel_posts(c.client_slug, c.kind)
            returning x.* loop
    select * into ch from operator_channels where id = o.channel_id;
    perform operator_log_job('operator', 'update.manual', o.client_slug, o.job_id,
                             jsonb_build_object('outbox_id', o.id, 'kind', ch.kind, 'channel', ch.name, 'url', ch.url, 'text', left(o.final_text, 3000)));
  end loop;
  for o in select x.* from operator_outbox x join operator_channels c on c.id = x.channel_id
            where x.status = 'approved' and operator_channel_posts(c.client_slug, c.kind)
            order by x.updated_at limit 20 for update of x skip locked loop
    if operator_send_blocker(o.client_slug) is null then
      update operator_outbox set status = 'sending', attempts = attempts + 1 where id = o.id returning * into o;
      return o;
    end if;
  end loop;
  return null;
end $$;

-- ---------- CEO ----------
create or replace function operator_request_send_test(p_client text, p_kind text, p_url text) returns text
language plpgsql security definer set search_path = public as $$
declare u text := btrim(coalesce(p_url, ''));
begin
  perform hq_guard();
  if not exists (select 1 from operator_clients where slug = p_client) then raise exception 'unknown client %', p_client; end if;
  if p_kind not in ('gmail', 'slack', 'teams') then raise exception 'send tests are for Slack, Teams and Gmail'; end if;
  if not operator_channel_url_ok(p_kind, u) then raise exception 'that is not a % address', p_kind; end if;
  insert into operator_posting (client_slug, kind, test_url, test_state, test_detail, updated_at) values (p_client, p_kind, u, 'requested', null, now())
  on conflict (client_slug, kind) do update set test_url = excluded.test_url, test_state = 'requested', test_detail = null, updated_at = now();
  perform operator_log('ceo', 'posting.test_requested', p_client, null, jsonb_build_object('kind', p_kind));
  return 'requested';
end $$;

create or replace function operator_set_posting(p_client text, p_kind text, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare p operator_posting;
begin
  perform hq_guard();
  select * into p from operator_posting where client_slug = p_client and kind = p_kind;
  if coalesce(p_on, false) and (p.client_slug is null or p.test_state <> 'passed' or p.tested_at <= now() - interval '30 days') then
    raise exception 'run a send test first (it must pass, and not be older than 30 days)';
  end if;
  if p.client_slug is null then return false; end if;
  update operator_posting set enabled = coalesce(p_on, false), updated_at = now() where client_slug = p_client and kind = p_kind;
  perform operator_log('ceo', case when p_on then 'posting.on' else 'posting.off' end, p_client, null, jsonb_build_object('kind', p_kind));
  return coalesce(p_on, false);
end $$;

-- ---------- operator (service) ----------
create or replace function operator_claim_send_test() returns operator_posting
language plpgsql security definer set search_path = public as $$
declare p operator_posting;
begin
  perform hq_guard();
  update operator_posting set test_state = 'failed', test_detail = 'interrupted: run the test again', updated_at = now()
   where test_state = 'running' and updated_at < now() - interval '10 minutes';
  select * into p from operator_posting where test_state = 'requested' order by updated_at limit 1 for update skip locked;
  if p.client_slug is null then return null; end if;
  update operator_posting set test_state = 'running', updated_at = now() where client_slug = p.client_slug and kind = p.kind returning * into p;
  return p;
end $$;

create or replace function operator_send_test_done(p_client text, p_kind text, p_ok boolean, p_detail text) returns text
language plpgsql security definer set search_path = public as $$
declare st text := case when p_ok then 'passed' else 'failed' end;
begin
  perform hq_guard();
  update operator_posting set test_state = st, test_detail = left(p_detail, 500), tested_at = case when p_ok then now() else tested_at end,
                              enabled = case when p_ok then enabled else false end, updated_at = now()
   where client_slug = p_client and kind = p_kind and test_state = 'running';
  if not found then return 'not_running'; end if;
  perform operator_log('operator', 'posting.tested', p_client, null, jsonb_build_object('kind', p_kind, 'ok', p_ok, 'detail', left(p_detail, 300)), p_ok);
  return st;
end $$;

drop index if exists operator_actions_notify;
create index operator_actions_notify on operator_actions (created_at) where telegram_sent_at is null
  and action in ('send.done', 'send.failed', 'send.blocked', 'message.classify_failed', 'watch.failed',
                 'update.done', 'update.failed', 'update.blocked', 'job.started', 'job.done', 'job.escalated', 'job.failed',
                 'action.done', 'action.failed', 'login.lost', 'login.restored', 'reply.manual', 'update.manual', 'posting.tested');

do $$
declare f text;
begin
  foreach f in array array['operator_channel_posts(text,text)', 'operator_claim_send()', 'operator_claim_update()',
                           'operator_claim_send_test()', 'operator_send_test_done(text,text,boolean,text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['operator_request_send_test(text,text,text)', 'operator_set_posting(text,text,boolean)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
