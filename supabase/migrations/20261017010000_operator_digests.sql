-- Julev Operator phase 3, milestone 2 (docs/17-OPERATOR.md "Digests"): a morning and an evening operator digest on
-- Telegram. Built from facts only (no AI, no cost): what came in, what was answered, what waits for the CEO, jobs done /
-- open / stuck, client updates sent, lost logins, failures and the operator's spend.
--   morning (default 08:00): everything since yesterday's evening digest time, plus what waits for you now
--   evening (default 18:00): everything since today's morning digest time, plus what is still open
-- The operator calls operator_digest_tick() every minute; it saves a digest once per day and kind when its time has
-- passed (reports row, kind operator_morning / operator_evening). The bot sends it like the other reports.

alter table reports drop constraint if exists reports_kind_check;
alter table reports add constraint reports_kind_check
  check (kind in ('standup', 'daily_digest', 'morning_brief', 'weekly', 'operator_morning', 'operator_evening'));

insert into settings (key, value) values ('operator_digest_times', '{"morning":"08:00","evening":"18:00"}'::jsonb)
on conflict (key) do nothing;

-- "HH:MM" of a digest kind (settings.operator_digest_times), null = that digest is off.
create or replace function operator_digest_time(p_kind text) returns time
language plpgsql stable security definer set search_path = public as $$
declare v text := (select value ->> (case p_kind when 'operator_morning' then 'morning' else 'evening' end) from settings where key = 'operator_digest_times');
begin
  if v is null then v := case p_kind when 'operator_morning' then '08:00' else '18:00' end; end if;
  if v !~ '^([01]\d|2[0-3]):[0-5]\d$' then return null; end if;
  return v::time;
end $$;

-- The facts of one digest for the window [p_from, p_to).
create or replace function operator_digest_facts(p_kind text, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  perform hq_guard();
  select jsonb_build_object(
    'kind', p_kind, 'from', p_from, 'to', p_to,
    'kill_switch', operator_setting_on('operator_paused'),
    'office_paused', operator_setting_on('paused'),
    'auto_send', operator_setting_on('operator_auto_send'),
    'online', coalesce((select (value ->> 'at')::timestamptz > p_to - interval '5 minutes' from settings where key = 'operator_heartbeat'), false),
    'spend_usd', coalesce((select round(sum(cost_usd)::numeric, 2) from activity_log
                            where actor = 'operator' and action like 'usage.%' and created_at >= p_from and created_at < p_to), 0),
    'clients', coalesce((select jsonb_agg(c order by c ->> 'name') from (
      select jsonb_build_object(
        'slug', oc.slug, 'name', oc.name, 'paused', oc.paused,
        'messages', (select count(*) from operator_inbox i where i.client_slug = oc.slug and not i.from_me
                       and i.created_at >= p_from and i.created_at < p_to and not (i.status = 'fyi' and i.category is null)),
        'replies_sent', (select count(*) from operator_actions a where a.client_slug = oc.slug and a.action = 'send.done'
                           and a.created_at >= p_from and a.created_at < p_to),
        'auto_sent', (select count(*) from operator_actions a where a.client_slug = oc.slug and a.action = 'send.done'
                        and a.detail ->> 'mode' = 'auto' and a.created_at >= p_from and a.created_at < p_to),
        'updates_sent', (select count(*) from operator_actions a where a.client_slug = oc.slug and a.action = 'update.done'
                           and a.created_at >= p_from and a.created_at < p_to),
        'waiting', (select count(*) from approvals ap where ap.status = 'pending' and ap.kind = 'external_action'
                      and ap.payload ->> 'type' in ('operator_reply', 'operator_update', 'operator_action', 'operator_memory', 'brain_proposal')
                      and coalesce(ap.payload ->> 'client', (select i.client_slug from operator_inbox i where i.approval_id = ap.id),
                                   (select j.client_slug from operator_jobs j where j.id = (ap.payload ->> 'job_id')::uuid)) = oc.slug),
        'jobs_done', coalesce((select jsonb_agg(jsonb_build_object('title', j.title, 'links', coalesce(j.result -> 'links', '[]'), 'cost_usd', j.cost_usd) order by j.finished_at)
                                 from operator_jobs j where j.client_slug = oc.slug and j.status = 'done' and j.finished_at >= p_from and j.finished_at < p_to), '[]'),
        'jobs_open', coalesce((select jsonb_agg(jsonb_build_object('title', j.title, 'status', j.status) order by j.created_at)
                                 from operator_jobs j where j.client_slug = oc.slug and j.status in ('queued', 'running', 'waiting', 'verifying')), '[]'),
        'jobs_stuck', coalesce((select jsonb_agg(jsonb_build_object('title', j.title, 'status', j.status, 'why', left(coalesce(j.result ->> 'needs_from_julev', j.error, ''), 200)) order by j.updated_at)
                                  from operator_jobs j where j.client_slug = oc.slug and j.status in ('escalated', 'failed')
                                   and j.updated_at >= p_to - interval '7 days'), '[]'),
        'logins_bad', coalesce((select jsonb_agg(l.label order by l.site) from operator_logins l
                                  where l.client_slug = oc.slug and l.enabled and l.state in ('signed_out', 'error')), '[]'),
        'failures', (select count(*) from operator_actions a where a.client_slug = oc.slug and not a.ok
                       and a.action in ('send.failed', 'watch.failed', 'action.failed', 'job.failed', 'update.failed', 'message.classify_failed')
                       and a.created_at >= p_from and a.created_at < p_to)
      ) c
      from operator_clients oc where oc.enabled) x), '[]')
  ) into out;
  return out;
end $$;

-- Called every minute by the operator (p_now injectable for tests). Saves each digest at most once per local day, once
-- its time has passed and only within 3 hours of it (a restart at 23:00 does not send the morning digest late).
-- Returns the kinds saved by this call.
create or replace function operator_digest_tick(p_now timestamptz default now()) returns text[]
language plpgsql security definer set search_path = public as $$
declare tz text := coalesce((select value #>> '{}' from settings where key = 'timezone'), 'Asia/Manila');
        local_now timestamp := p_now at time zone tz; today date := (p_now at time zone tz)::date;
        k text; at_t time; due timestamp; prev_t time; w_from timestamptz; facts jsonb; rid uuid; saved text[] := '{}';
begin
  perform hq_guard();
  if not exists (select 1 from operator_clients where enabled) then return saved; end if;
  foreach k in array array['operator_morning', 'operator_evening'] loop
    at_t := operator_digest_time(k);
    if at_t is null then continue; end if;
    due := today + at_t;
    if local_now < due or local_now >= due + interval '3 hours' then continue; end if;
    if exists (select 1 from reports where agent_id is null and report_date = today and kind = k) then continue; end if;
    -- window: since the other digest's time (yesterday's evening for the morning one, this morning's for the evening one)
    prev_t := coalesce(operator_digest_time(case k when 'operator_morning' then 'operator_evening' else 'operator_morning' end),
                       case k when 'operator_morning' then '18:00'::time else '08:00'::time end);
    w_from := ((case when k = 'operator_morning' or prev_t > at_t then today - 1 else today end) + prev_t) at time zone tz;
    facts := operator_digest_facts(k, w_from, p_now);
    insert into reports (agent_id, report_date, kind, body_md, data)
    values (null, today, k, case k when 'operator_morning' then 'Operator morning digest' else 'Operator evening digest' end, facts)
    on conflict do nothing
    returning id into rid;
    if rid is not null then
      saved := array_append(saved, k);
      perform operator_log('operator', 'digest.saved', null, null, jsonb_build_object('kind', k, 'report_id', rid));
    end if;
  end loop;
  return saved;
end $$;

-- The CEO sets the digest times ('HH:MM', or null = off).
create or replace function operator_set_digest_times(p_morning text, p_evening text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform hq_guard();
  if p_morning is not null and p_morning !~ '^([01]\d|2[0-3]):[0-5]\d$' then raise exception 'morning time must be HH:MM'; end if;
  if p_evening is not null and p_evening !~ '^([01]\d|2[0-3]):[0-5]\d$' then raise exception 'evening time must be HH:MM'; end if;
  v := jsonb_build_object('morning', coalesce(p_morning, 'off'), 'evening', coalesce(p_evening, 'off'));
  insert into settings (key, value) values ('operator_digest_times', v) on conflict (key) do update set value = excluded.value;
  perform operator_log('ceo', 'digest.times', null, null, v);
  return v;
end $$;

do $$
declare f text;
begin
  foreach f in array array['operator_digest_time(text)', 'operator_digest_facts(text,timestamptz,timestamptz)', 'operator_digest_tick(timestamptz)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  execute 'revoke execute on function operator_set_digest_times(text,text) from public, anon';
  execute 'grant execute on function operator_set_digest_times(text,text) to authenticated, service_role';
end $$;
