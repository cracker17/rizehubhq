-- RizeHub HQ · M7 reports + Telegram notifier (docs/05 "Scheduled work", docs/06 §5, docs/08).
-- * reports: new kind 'morning_brief', structured `data`, one row per (author, date, kind) even when
--   agent_id is null, Telegram delivery marker.
-- * report_facts(): the numbers every report is built from (worker, bot /report, db tests).
-- * save_report(): idempotent insert used by the worker scheduler.
-- * set_paused(): /pause and /resume (the worker stops claiming new work while paused).

-- ---------- reports table ----------
alter table reports drop constraint if exists reports_kind_check;
alter table reports add constraint reports_kind_check
  check (kind in ('standup', 'daily_digest', 'morning_brief', 'weekly'));

alter table reports add column if not exists data jsonb not null default '{}';   -- structured fields for the dashboard
alter table reports add column if not exists telegram_sent_at timestamptz;          -- set once by the bot

-- unique (agent_id, report_date, kind) treats NULL agent_ids as distinct; make it one per day for real.
alter table reports drop constraint if exists reports_agent_id_report_date_kind_key;
create unique index if not exists reports_one_per_day on reports ((coalesce(agent_id, '')), report_date, kind);
create index if not exists reports_date_kind on reports (report_date desc, kind);

-- ---------- settings defaults (seed.sql owns the rest) ----------
insert into settings (key, value) values
  ('paused', 'false'),
  ('quiet_hours', '{"start":"22:00","end":"07:00"}'),
  ('morning_brief_time', '"08:00"'),
  ('weekly_time', '"08:00"')
on conflict (key) do nothing;

-- ---------- facts ----------
-- Window = [p_from 00:00, p_from + p_days) in the HQ timezone (settings.timezone, default Asia/Manila).
-- Lists that describe "right now" (in progress, queued, blocked, approvals waiting) are a live snapshot.
create or replace function report_facts(p_from date, p_days int default 1) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  tz text := coalesce((select value #>> '{}' from settings where key = 'timezone'), 'Asia/Manila');
  t0 timestamptz; t1 timestamptz; out jsonb;
begin
  perform hq_guard();
  t0 := p_from::timestamp at time zone tz;
  t1 := (p_from + greatest(1, p_days))::timestamp at time zone tz;

  select jsonb_build_object(
    'from', p_from, 'to', p_from + greatest(1, p_days), 'tz', tz,
    'spend_usd', (select coalesce(sum(cost_usd), 0) from activity_log where created_at >= t0 and created_at < t1),
    'spend_by_actor', (select coalesce(jsonb_agg(jsonb_build_object('actor', actor, 'usd', usd) order by usd desc), '[]')
                       from (select actor, sum(cost_usd) usd from activity_log
                             where created_at >= t0 and created_at < t1 and cost_usd > 0 group by actor) s),
    'spend_by_client', (select coalesce(jsonb_agg(jsonb_build_object('client_id', s.client_id, 'name', c.name, 'usd', s.usd) order by s.usd desc), '[]')
                        from (select client_id, sum(cost_usd) usd from activity_log
                              where created_at >= t0 and created_at < t1 and cost_usd > 0 and client_id is not null group by client_id) s
                        join clients c on c.id = s.client_id),
    'qa', (select jsonb_build_object('reviews', count(*), 'passed', count(*) filter (where verdict = 'pass'))
           from qa_reviews where created_at >= t0 and created_at < t1),
    'qa_by_day', (select coalesce(jsonb_agg(jsonb_build_object('date', d, 'reviews', n, 'passed', p) order by d), '[]')
                  from (select (created_at at time zone tz)::date d, count(*) n, count(*) filter (where verdict = 'pass') p
                        from qa_reviews where created_at >= t0 and created_at < t1 group by 1) q),
    'done', (select coalesce(jsonb_agg(jsonb_build_object(
                'task_id', t.id, 'title', t.title, 'agent_id', t.agent_id, 'client_id', t.client_id, 'client_name', c.name,
                'request_title', r.title, 'completed_at', t.completed_at, 'revision_count', t.revision_count,
                'cost_usd', t.cost_usd) order by t.completed_at), '[]')
             from tasks t join requests r on r.id = t.request_id left join clients c on c.id = t.client_id
             where t.status = 'done' and t.completed_at >= t0 and t.completed_at < t1),
    'in_progress', (select coalesce(jsonb_agg(jsonb_build_object(
                'task_id', t.id, 'title', t.title, 'agent_id', t.agent_id, 'status', t.status, 'client_id', t.client_id,
                'client_name', c.name, 'revision_count', t.revision_count) order by t.updated_at desc), '[]')
             from tasks t left join clients c on c.id = t.client_id
             where t.status in ('working', 'qa_pending', 'qa_reviewing', 'revision')
                or (t.status = 'queued' and t.started_at is not null)),
    'queued', (select coalesce(jsonb_agg(jsonb_build_object(
                'task_id', t.id, 'title', t.title, 'agent_id', t.agent_id, 'status', t.status, 'client_id', t.client_id,
                'client_name', c.name, 'priority', r.priority, 'due_date', r.due_date) order by
                case r.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.created_at), '[]')
             from tasks t join requests r on r.id = t.request_id left join clients c on c.id = t.client_id
             where t.status in ('queued', 'pending') and t.started_at is null and r.status = 'in_progress'),
    'blocked', (select coalesce(jsonb_agg(b order by b ->> 'since'), '[]') from (
                select jsonb_build_object('task_id', t.id, 'title', t.title, 'agent_id', t.agent_id, 'client_name', c.name,
                         'kind', 'failed', 'since', t.updated_at,
                         'reason', coalesce((select ap.summary from approvals ap where ap.task_id = t.id and ap.status = 'pending'
                                             order by ap.created_at desc limit 1), 'Task failed')) b
                from tasks t join requests r on r.id = t.request_id left join clients c on c.id = t.client_id
                where t.status = 'failed' and r.status = 'in_progress'
                union all
                select jsonb_build_object('task_id', t.id, 'title', t.title, 'agent_id', t.agent_id, 'client_name', c.name,
                         'kind', 'question', 'since', ap.created_at, 'reason', coalesce(ap.payload ->> 'question', ap.summary, ap.title))
                from tasks t join approvals ap on ap.task_id = t.id and ap.status = 'pending' and ap.kind = 'external_action'
                     and ap.payload ->> 'type' = 'question'
                left join clients c on c.id = t.client_id
                where t.status = 'awaiting_ceo') x),
    'approvals_waiting', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', ap.id, 'kind', ap.kind, 'title', ap.title, 'agent_id', ap.agent_id, 'created_at', ap.created_at,
                'type', ap.payload ->> 'type', 'priority', r.priority) order by ap.created_at), '[]')
             from approvals ap left join requests r on r.id = ap.request_id where ap.status = 'pending'),
    'events', (select coalesce(jsonb_agg(e order by e ->> 'at'), '[]') from (
                select jsonb_build_object('actor', l.actor, 'action', l.action, 'task_id', l.task_id, 'task_title', t.title,
                         'request_title', coalesce(r.title, left(r.raw_text, 80)), 'at', l.created_at, 'detail', l.detail) e
                from activity_log l left join tasks t on t.id = l.task_id left join requests r on r.id = l.request_id
                where l.created_at >= t0 and l.created_at < t1 and l.action not like 'usage.%'
                  and l.actor not in ('ceo', 'system')
                order by l.created_at limit 500) x),
    'requests_created', (select count(*) from requests where created_at >= t0 and created_at < t1),
    'due_soon', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'title', coalesce(r.title, left(r.raw_text, 80)),
                'due_date', r.due_date, 'status', r.status, 'client_name', c.name) order by r.due_date), '[]')
             from requests r left join clients c on c.id = r.client_id
             where r.due_date is not null and r.due_date < p_from + greatest(1, p_days) + 3
               and r.status not in ('done', 'rejected', 'cancelled', 'failed')),
    'agents', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'department', department) order by id), '[]')
               from agents where enabled)
  ) into out;
  return out;
end $$;

-- ---------- save ----------
-- Returns the report id, or null when that (author, date, kind) already exists and p_overwrite is false.
create or replace function save_report(p_agent text, p_date date, p_kind text, p_done jsonb, p_next jsonb, p_blockers jsonb,
                                       p_body text, p_cost numeric default 0, p_data jsonb default '{}', p_overwrite boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  perform hq_guard();
  if p_overwrite then
    update reports set done = coalesce(p_done, '[]'), next = coalesce(p_next, '[]'), blockers = coalesce(p_blockers, '[]'),
                       body_md = p_body, cost_usd = coalesce(p_cost, 0), data = coalesce(p_data, '{}'), created_at = now()
     where coalesce(agent_id, '') = coalesce(p_agent, '') and report_date = p_date and kind = p_kind
    returning id into rid;
    if rid is not null then return rid; end if;
  end if;
  insert into reports (agent_id, report_date, kind, done, next, blockers, body_md, cost_usd, data)
  values (p_agent, p_date, p_kind, coalesce(p_done, '[]'), coalesce(p_next, '[]'), coalesce(p_blockers, '[]'),
          p_body, coalesce(p_cost, 0), coalesce(p_data, '{}'))
  on conflict do nothing
  returning id into rid;
  if rid is not null and p_kind <> 'standup' then
    perform hq_log(coalesce(p_agent, 'system'), 'report.' || p_kind, null, null, jsonb_build_object('report_id', rid, 'date', p_date));
  end if;
  return rid;
end $$;

-- ---------- pause / resume ----------
create or replace function set_paused(p_paused boolean, p_via text default 'dashboard') returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  insert into settings (key, value) values ('paused', to_jsonb(coalesce(p_paused, false)))
  on conflict (key) do update set value = excluded.value;
  perform hq_log('ceo', case when p_paused then 'office.paused' else 'office.resumed' end, null, null, jsonb_build_object('via', p_via));
  return coalesce(p_paused, false);
end $$;

do $$
declare f text;
begin
  foreach f in array array['report_facts(date,int)',
    'save_report(text,date,text,jsonb,jsonb,jsonb,text,numeric,jsonb,boolean)', 'set_paused(boolean,text)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
