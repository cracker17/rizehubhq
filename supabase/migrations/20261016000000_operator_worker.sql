-- Julev Operator, phase 2 (docs/17-OPERATOR.md "Worker mode"): the operator does the work a client asked for, checks
-- it in the browser, writes what it did to the Brain, and tells the client. Builds on 20261015000000_operator.sql.
--
--   operator_jobs         one job per task: from an approved task reply (✅ Send on a "new task" draft) or from the CEO
--                         (/task on Telegram). queued → running → waiting (outside-world actions to approve) → verifying
--                         (QA in the browser) → done | escalated | failed | cancelled
--   operator_job_actions  every outside-world change a job wants (Webflow CMS write / publish, Airtable write, a risky
--                         browser click, a delete): an approval first (payload.type 'operator_action'), executed by the
--                         operator only after ✅, never retried once started (CLAUDE.md rule 4)
--   operator_outbox       status updates to the client's thread when a job finished (tiers: action type 'status')
--   operator_evidence     QA screenshots (375 / 1366 px) attached to Telegram updates; pruned after 30 days
--   operator_memory       session notes, decisions and next steps of finished jobs: Brain proposals. With HQ Brain M4
--                         (brain_proposals, 20260930040000_brain_agents.sql) they go straight there; without it they wait
--                         here (approved in the normal inbox) and operator_memory_promote() hands them over later
--   operator_logins       per client and site: "still logged in?" checks (Google, Webflow, Airtable); a lost login is a
--                         Telegram notice
-- Every state change is a service-only SQL function (the operator app is a thin door); the CEO reads everything.

-- ---------- audit log: job steps ----------
alter table operator_actions add column if not exists job_id uuid;
create index if not exists operator_actions_job on operator_actions (job_id, id);
drop index if exists operator_actions_notify;
create index operator_actions_notify on operator_actions (created_at) where telegram_sent_at is null
  and action in ('send.done', 'send.failed', 'send.blocked', 'message.classify_failed', 'watch.failed',
                 'update.done', 'update.failed', 'update.blocked', 'job.started', 'job.done', 'job.escalated', 'job.failed',
                 'action.done', 'action.failed', 'login.lost', 'login.restored');

create or replace function operator_log_job(p_actor text, p_action text, p_client text, p_job uuid, p_detail jsonb default '{}', p_ok boolean default true)
returns void language sql security definer set search_path = public as $$
  insert into operator_actions (actor, action, client_slug, job_id, detail, ok)
  values (p_actor, p_action, p_client, p_job, coalesce(p_detail, '{}'), coalesce(p_ok, true));
$$;

-- ---------- API credentials (HQ Client Vault) ----------
alter table operator_clients add column if not exists webflow_credential uuid references client_credentials(id) on delete set null;
alter table operator_clients add column if not exists airtable_credential uuid references client_credentials(id) on delete set null;

-- ---------- jobs ----------
create table operator_jobs (
  id           uuid primary key default gen_random_uuid(),
  client_slug  text not null references operator_clients(slug) on delete cascade,
  inbox_id     uuid unique references operator_inbox(id) on delete set null,      -- the client message that asked for it
  channel_id   uuid references operator_channels(id) on delete set null,          -- where the status update goes
  source       text not null check (source in ('chat', 'ceo')),
  title        text not null check (length(title) between 1 and 200),
  brief        text not null check (length(brief) between 3 and 8000),
  plan         jsonb not null default '[]',
  status       text not null default 'queued' check (status in ('queued', 'running', 'waiting', 'verifying', 'done',
                                                                 'escalated', 'failed', 'cancelled')),
  runs         int not null default 0,
  max_runs     int not null default 4 check (max_runs between 1 and 10),
  feedback     text,                       -- what the next run must deal with (QA findings, the CEO's note)
  result       jsonb not null default '{}', -- summary, links, next_steps, decisions, client_update (from the agent)
  qa           jsonb,                       -- last QA report (checks, errors, evidence ids)
  cost_usd     numeric(10, 4) not null default 0,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
create index operator_jobs_status on operator_jobs (status, created_at);
create index operator_jobs_client on operator_jobs (client_slug, created_at desc);
create trigger operator_jobs_touch before update on operator_jobs for each row execute function touch_updated_at();

create table operator_job_actions (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references operator_jobs(id) on delete cascade,
  client_slug  text not null,
  kind         text not null check (kind in ('webflow_cms', 'webflow_publish', 'airtable_write', 'browser_click', 'delete', 'other')),
  summary      text not null check (length(summary) between 3 and 1000),
  spec         jsonb not null default '{}' check (octet_length(spec::text) <= 100000),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'executing', 'done', 'failed', 'cancelled')),
  approval_id  uuid references approvals(id) on delete set null,
  ceo_note     text,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  executed_at  timestamptz
);
create index operator_job_actions_job on operator_job_actions (job_id, created_at);
create index operator_job_actions_status on operator_job_actions (status, updated_at);
create trigger operator_job_actions_touch before update on operator_job_actions for each row execute function touch_updated_at();

create table operator_outbox (
  id           uuid primary key default gen_random_uuid(),
  client_slug  text not null references operator_clients(slug) on delete cascade,
  channel_id   uuid not null references operator_channels(id) on delete cascade,
  inbox_id     uuid references operator_inbox(id) on delete set null,   -- answered in that message's thread
  job_id       uuid references operator_jobs(id) on delete set null,
  text         text not null check (length(text) between 1 and 4000),
  mentions     jsonb not null default '[]',
  mode         text not null check (mode in ('auto', 'approve', 'never')),
  status       text not null check (status in ('drafted', 'approved', 'sending', 'sent', 'skipped', 'failed', 'blocked')),
  final_text   text,
  approval_id  uuid references approvals(id) on delete set null,
  attempts     int not null default 0,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  handled_at   timestamptz
);
create index operator_outbox_status on operator_outbox (status, updated_at);
create trigger operator_outbox_touch before update on operator_outbox for each row execute function touch_updated_at();

create table operator_evidence (
  id           bigserial primary key,
  job_id       uuid references operator_jobs(id) on delete cascade,
  created_at   timestamptz not null default now(),
  label        text not null check (length(label) between 1 and 120),
  url          text,
  mime         text not null check (mime in ('image/jpeg', 'image/png')),
  data         bytea not null check (octet_length(data) between 1 and 1572864)
);
create index operator_evidence_job on operator_evidence (job_id, id);

create table operator_memory (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid references operator_jobs(id) on delete set null,
  client_slug       text not null,
  project_slug      text not null check (project_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  kind              text not null check (kind in ('session_note', 'decision', 'next_step')),
  text              text not null check (length(text) between 3 and 2000),
  status            text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  approval_id       uuid references approvals(id) on delete set null,
  brain_proposal_id uuid,               -- set once it is in brain_proposals (M4)
  created_at        timestamptz not null default now(),
  decided_at        timestamptz
);
create index operator_memory_client on operator_memory (client_slug, created_at desc);

create table operator_logins (
  client_slug     text not null references operator_clients(slug) on delete cascade,
  site            text not null check (site ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  label           text not null,
  check_url       text not null check (check_url ~ '^https://[^\s]+$'),
  enabled         boolean not null default true,
  state           text not null default 'unknown' check (state in ('unknown', 'ok', 'signed_out', 'error')),
  detail          text,
  last_checked_at timestamptz,
  last_ok_at      timestamptz,
  primary key (client_slug, site)
);

-- ---------- RLS: the CEO reads, only the service role writes ----------
do $$
declare t text;
begin
  foreach t in array array['operator_jobs', 'operator_job_actions', 'operator_outbox', 'operator_evidence', 'operator_memory', 'operator_logins'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy ceo_read on %I for select to authenticated using (is_ceo())', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;
revoke all on sequence operator_evidence_id_seq from anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'operator_jobs') then
    alter publication supabase_realtime add table operator_jobs;
  end if;
end $$;

-- ---------- queueing a job ----------
create or replace function operator_queue_job(p_client text, p_source text, p_title text, p_brief text, p_plan jsonb,
                                              p_inbox uuid, p_channel uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare jid uuid; b text := left(btrim(coalesce(p_brief, '')), 8000);
begin
  if not exists (select 1 from operator_clients where slug = p_client) then raise exception 'unknown client %', p_client; end if;
  if length(b) < 3 then raise exception 'describe the task (at least a few words)'; end if;
  insert into operator_jobs (client_slug, source, title, brief, plan, inbox_id, channel_id)
  values (p_client, p_source, left(coalesce(nullif(btrim(p_title), ''), split_part(b, E'\n', 1)), 200), b,
          case when jsonb_typeof(p_plan) = 'array' then p_plan else '[]'::jsonb end, p_inbox, p_channel)
  on conflict (inbox_id) do nothing
  returning id into jid;
  if jid is not null then
    perform operator_log_job(case when p_source = 'ceo' then 'ceo' else 'operator' end, 'job.queued', p_client, jid,
                             jsonb_build_object('title', left(coalesce(nullif(btrim(p_title), ''), split_part(b, E'\n', 1)), 200), 'source', p_source));
  end if;
  return jid;
end $$;

-- The CEO adds a task (Telegram /task <client> <what>, or the dashboard). Optionally names the chat the client update
-- goes to; without one the result only goes to Telegram.
create or replace function operator_add_job(p_client text, p_brief text, p_channel uuid default null, p_via text default 'telegram') returns uuid
language plpgsql security definer set search_path = public as $$
declare jid uuid;
begin
  perform hq_guard();
  if p_channel is not null and not exists (select 1 from operator_channels where id = p_channel and client_slug = p_client) then
    raise exception 'that chat is not one of %''s', p_client;
  end if;
  jid := operator_queue_job(p_client, 'ceo', null, p_brief, '[]'::jsonb, null, p_channel);
  update operator_actions set detail = detail || jsonb_build_object('via', coalesce(p_via, 'telegram'))
   where job_id = jid and action = 'job.queued';
  return jid;
end $$;

create or replace function operator_cancel_job(p_job uuid, p_via text default 'telegram') returns text
language plpgsql security definer set search_path = public as $$
declare j operator_jobs;
begin
  perform hq_guard();
  update operator_jobs set status = 'cancelled', finished_at = now()
   where id = p_job and status not in ('done', 'failed', 'cancelled') returning * into j;
  if j.id is null then return 'not_open'; end if;
  update operator_job_actions set status = 'cancelled' where job_id = j.id and status in ('pending', 'approved');
  perform operator_log_job('ceo', 'job.cancelled', j.client_slug, j.id, jsonb_build_object('via', coalesce(p_via, 'telegram')));
  return 'cancelled';
end $$;

-- A "new task" reply draft: ✅ Send / ✏️ Edit post the acknowledgement AND queue the job (the CEO approved the plan in
-- the same tap); ⏭ Skip does neither. Replaces the phase 1 trigger function (same behaviour for plain replies).
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
    if r.category = 'task' and (new.status = 'approved' or (new.status = 'changes_requested' and nullif(btrim(coalesce(new.ceo_note, '')), '') is not null)) then
      perform operator_queue_job(r.client_slug, 'chat', coalesce(nullif(r.analysis ->> 'summary', ''), left(r.body, 120)),
                                 'From ' || coalesce(nullif(r.sender_name, ''), 'the client') || ' in ' || coalesce(r.space_name, 'chat') || E':\n' || r.body,
                                 coalesce(r.analysis -> 'task_plan', '[]'::jsonb), r.id, r.channel_id);
    end if;
  end if;
  return new;
end $$;

-- ---------- running a job (service role) ----------
-- Next job to run. Nothing runs while the kill switch, the office pause or the client's pause is on. A run that died
-- (crash, restart) for 45 minutes counts as a used run and is picked up again.
create or replace function operator_claim_job() returns operator_jobs
language plpgsql security definer set search_path = public as $$
declare j operator_jobs;
begin
  perform hq_guard();
  for j in update operator_jobs set status = 'failed', finished_at = now(), error = 'interrupted too often'
            where status = 'running' and updated_at < now() - interval '45 minutes' and runs >= max_runs returning * loop
    perform operator_log_job('operator', 'job.failed', j.client_slug, j.id, jsonb_build_object('error', j.error), false);
  end loop;
  for j in select * from operator_jobs
            where status = 'queued' or (status = 'running' and updated_at < now() - interval '45 minutes')
            order by created_at limit 20 for update skip locked loop
    if operator_send_blocker(j.client_slug) is null then
      update operator_jobs set status = 'running', runs = runs + 1, started_at = coalesce(started_at, now()), error = null
       where id = j.id returning * into j;
      if j.runs = 1 then perform operator_log_job('operator', 'job.started', j.client_slug, j.id, jsonb_build_object('title', j.title)); end if;
      return j;
    end if;
  end loop;
  return null;
end $$;

-- One step of a running job (the live feed on /operator, the wall). Keeps a long run from looking stale.
create or replace function operator_job_step(p_job uuid, p_action text, p_detail jsonb default '{}', p_ok boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare j operator_jobs;
begin
  perform hq_guard();
  select * into j from operator_jobs where id = p_job;
  if j.id is null then raise exception 'unknown job'; end if;
  if j.status = 'running' then update operator_jobs set updated_at = now() where id = j.id; end if;
  perform operator_log_job('operator', p_action, j.client_slug, j.id, p_detail, p_ok);
end $$;

-- The job wants to change the outside world: an approval first. At most 20 open per job.
create or replace function operator_request_action(p_job uuid, p_kind text, p_summary text, p_spec jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare j operator_jobs; c operator_clients; aid uuid; xid uuid; s text := left(btrim(coalesce(p_summary, '')), 1000);
begin
  perform hq_guard();
  select * into j from operator_jobs where id = p_job for update;
  if j.id is null then raise exception 'unknown job'; end if;
  if j.status <> 'running' then raise exception 'the job is not running (%)', j.status; end if;
  if length(s) < 3 then raise exception 'say what the action does'; end if;
  if (select count(*) from operator_job_actions where job_id = j.id and status in ('pending', 'approved', 'executing')) >= 20 then
    raise exception 'too many actions waiting for this job';
  end if;
  select * into c from operator_clients where slug = j.client_slug;
  insert into operator_job_actions (job_id, client_slug, kind, summary, spec)
  values (j.id, j.client_slug, p_kind, s, coalesce(p_spec, '{}')) returning id into xid;
  insert into approvals (kind, title, summary, payload)
  values ('external_action',
          left(case p_kind when 'webflow_publish' then 'Publish' when 'webflow_cms' then 'Webflow CMS change'
                           when 'airtable_write' then 'Airtable change' when 'browser_click' then 'Click in the browser'
                           when 'delete' then 'Delete' else 'Action' end || ' (' || c.name || '): ' || s, 200),
          s,
          jsonb_build_object('type', 'operator_action', 'action_id', xid, 'job_id', j.id, 'job_title', j.title,
                             'client', c.slug, 'client_name', c.name, 'action_kind', p_kind, 'spec', coalesce(p_spec, '{}')))
  returning id into aid;
  update operator_job_actions set approval_id = aid where id = xid;
  perform operator_log_job('operator', 'action.requested', j.client_slug, j.id, jsonb_build_object('action_id', xid, 'kind', p_kind, 'summary', left(s, 300), 'approval_id', aid));
  return jsonb_build_object('action_id', xid, 'approval_id', aid);
end $$;

-- A waiting job goes back to the queue once none of its actions is still open (its next run sees the results).
create or replace function operator_job_maybe_resume(p_job uuid) returns void
language plpgsql security definer set search_path = public as $$
declare j operator_jobs;
begin
  select * into j from operator_jobs where id = p_job for update;
  if j.id is null or j.status <> 'waiting' then return; end if;
  if exists (select 1 from operator_job_actions where job_id = j.id and status in ('pending', 'approved', 'executing')) then return; end if;
  if j.runs >= j.max_runs then
    update operator_jobs set status = 'escalated', finished_at = now(), error = 'no runs left after its actions' where id = j.id;
    perform operator_log_job('operator', 'job.escalated', j.client_slug, j.id, jsonb_build_object('reason', 'no runs left after its actions'), false);
    return;
  end if;
  update operator_jobs set status = 'queued' where id = j.id;
  perform operator_log_job('operator', 'job.resumed', j.client_slug, j.id, '{}');
end $$;

-- ✅ = approved (the operator executes it), ✏️ / ❌ = rejected with the CEO's note (the job's next run reads it).
create or replace function operator_action_on_decision() returns trigger
language plpgsql security definer set search_path = public as $$
declare x operator_job_actions;
begin
  if coalesce(new.payload ->> 'type', '') = 'operator_action' and old.status = 'pending' and new.status <> 'pending' then
    update operator_job_actions set status = case when new.status = 'approved' then 'approved' else 'rejected' end,
                                    ceo_note = new.ceo_note
     where id = (new.payload ->> 'action_id')::uuid and status = 'pending' returning * into x;
    if x.id is null then return new; end if;
    perform operator_log_job('ceo', case when new.status = 'approved' then 'action.approved' else 'action.rejected' end, x.client_slug, x.job_id,
                             jsonb_build_object('action_id', x.id, 'kind', x.kind, 'via', new.decided_via, 'note', left(new.ceo_note, 300)));
    if x.status = 'rejected' then perform operator_job_maybe_resume(x.job_id); end if;
  end if;
  return new;
end $$;
create trigger operator_action_decided after update of status on approvals for each row execute function operator_action_on_decision();

-- Next approved action to execute. Refused while any pause is on. One interrupted for 15 minutes is failed, never
-- retried (it may have happened).
create or replace function operator_claim_action() returns operator_job_actions
language plpgsql security definer set search_path = public as $$
declare x operator_job_actions;
begin
  perform hq_guard();
  for x in update operator_job_actions set status = 'failed', executed_at = now(), error = 'interrupted while executing: check before doing it again'
            where status = 'executing' and updated_at < now() - interval '15 minutes' returning * loop
    perform operator_log_job('operator', 'action.failed', x.client_slug, x.job_id, jsonb_build_object('action_id', x.id, 'error', x.error), false);
    perform operator_job_maybe_resume(x.job_id);
  end loop;
  for x in select a.* from operator_job_actions a join operator_jobs j on j.id = a.job_id
            where a.status = 'approved' and j.status not in ('cancelled', 'failed')
            order by a.updated_at limit 20 for update of a skip locked loop
    if operator_send_blocker(x.client_slug) is null then
      update operator_job_actions set status = 'executing' where id = x.id returning * into x;
      return x;
    end if;
  end loop;
  return null;
end $$;

-- Right before the outside-world call: still allowed? (a /pause that landed meanwhile stops it here)
create or replace function operator_action_may_run(p_action uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(operator_send_blocker(x.client_slug), case when x.status = 'executing' then null else 'not claimed' end)
    from operator_job_actions x where x.id = p_action;
$$;

create or replace function operator_action_done(p_action uuid, p_ok boolean, p_result jsonb default '{}', p_error text default null) returns text
language plpgsql security definer set search_path = public as $$
declare x operator_job_actions;
begin
  perform hq_guard();
  update operator_job_actions set status = case when p_ok then 'done' else 'failed' end, executed_at = now(),
                                  result = coalesce(p_result, '{}'), error = left(p_error, 1000)
   where id = p_action and status = 'executing' returning * into x;
  if x.id is null then return 'not_executing'; end if;
  perform operator_log_job('operator', case when p_ok then 'action.done' else 'action.failed' end, x.client_slug, x.job_id,
                           jsonb_build_object('action_id', x.id, 'kind', x.kind, 'summary', left(x.summary, 300), 'error', left(p_error, 300)), p_ok);
  perform operator_job_maybe_resume(x.job_id);
  return x.status;
end $$;

-- A run ended. p_outcome:
--   finished  the agent called finish: verify next (or wait for its actions first)
--   waiting   the agent stopped to wait for approvals
--   blocked   the agent can't do it (needs a person): escalated
--   error     the run failed: retried while runs are left, else failed
create or replace function operator_job_run_done(p_job uuid, p_outcome text, p_result jsonb default '{}', p_cost numeric default 0,
                                                 p_error text default null) returns text
language plpgsql security definer set search_path = public as $$
declare j operator_jobs; open_actions boolean; st text;
begin
  perform hq_guard();
  select * into j from operator_jobs where id = p_job for update;
  if j.id is null then raise exception 'unknown job'; end if;
  if j.status <> 'running' then return 'not_running'; end if;
  open_actions := exists (select 1 from operator_job_actions where job_id = j.id and status in ('pending', 'approved', 'executing'));
  st := case p_outcome
          when 'finished' then case when open_actions then 'waiting' else 'verifying' end
          when 'waiting' then case when open_actions then 'waiting' else 'queued' end
          when 'blocked' then 'escalated'
          when 'error' then case when j.runs >= j.max_runs then 'failed' else 'queued' end
          else null end;
  if st is null then raise exception 'bad outcome %', p_outcome; end if;
  if p_outcome = 'waiting' and not open_actions and j.runs >= j.max_runs then st := 'escalated'; end if;
  update operator_jobs set status = st, cost_usd = cost_usd + greatest(coalesce(p_cost, 0), 0),
                           result = case when p_outcome in ('finished', 'blocked') then coalesce(p_result, '{}') else result end,
                           error = case when p_outcome in ('error', 'blocked') then left(coalesce(p_error, p_result ->> 'summary'), 1000) else null end,
                           feedback = case when st = 'queued' and p_outcome = 'error' then 'The previous run failed: ' || left(coalesce(p_error, ''), 500) else feedback end,
                           finished_at = case when st in ('failed', 'escalated') then now() else finished_at end
   where id = j.id;
  perform operator_log_job('operator', case st when 'failed' then 'job.failed' when 'escalated' then 'job.escalated'
                                               when 'waiting' then 'job.waiting' when 'verifying' then 'job.verifying' else 'job.run_ended' end,
                           j.client_slug, j.id,
                           jsonb_build_object('outcome', p_outcome, 'run', j.runs, 'error', left(p_error, 300),
                                              'summary', left(p_result ->> 'summary', 500), 'cost_usd', coalesce(p_cost, 0)),
                           st not in ('failed', 'escalated'));
  return st;
end $$;

-- QA verdict on a finished job: pass → done; fail → another run with the findings while runs are left, else escalated.
create or replace function operator_job_verified(p_job uuid, p_pass boolean, p_qa jsonb default '{}', p_feedback text default null) returns text
language plpgsql security definer set search_path = public as $$
declare j operator_jobs; st text;
begin
  perform hq_guard();
  select * into j from operator_jobs where id = p_job for update;
  if j.id is null then raise exception 'unknown job'; end if;
  if j.status <> 'verifying' then return 'not_verifying'; end if;
  st := case when p_pass then 'done' when j.runs < j.max_runs then 'queued' else 'escalated' end;
  update operator_jobs set status = st, qa = coalesce(p_qa, '{}'),
                           feedback = case when st = 'queued' then left(p_feedback, 4000) else feedback end,
                           error = case when st = 'escalated' then left(coalesce(p_feedback, 'QA kept failing'), 1000) else error end,
                           finished_at = case when st in ('done', 'escalated') then now() else finished_at end
   where id = j.id;
  perform operator_log_job('operator', case st when 'done' then 'job.done' when 'queued' then 'job.qa_failed' else 'job.escalated' end,
                           j.client_slug, j.id,
                           jsonb_build_object('title', j.title, 'summary', left(j.result ->> 'summary', 1500), 'links', coalesce(j.result -> 'links', '[]'),
                                              'qa', jsonb_build_object('pass', p_pass, 'errors', coalesce(p_qa -> 'errors', '[]'), 'evidence', coalesce(p_qa -> 'evidence', '[]')),
                                              'reason', left(p_feedback, 500), 'cost_usd', j.cost_usd),
                           st <> 'escalated');
  return st;
end $$;

-- ---------- status update to the client (tiers: action type 'status') ----------
create or replace function operator_queue_update(p_job uuid, p_text text, p_mentions jsonb default '[]') returns text
language plpgsql security definer set search_path = public as $$
declare j operator_jobs; c operator_clients; ch operator_channels; m text; oid uuid; aid uuid; t text := left(btrim(coalesce(p_text, '')), 4000);
        msg operator_inbox;
begin
  perform hq_guard();
  select * into j from operator_jobs where id = p_job;
  if j.id is null then raise exception 'unknown job'; end if;
  if j.channel_id is null then return 'no_channel'; end if;
  if t = '' then return 'empty'; end if;
  if exists (select 1 from operator_outbox where job_id = j.id and status not in ('skipped', 'failed', 'blocked')) then return 'already_queued'; end if;
  select * into c from operator_clients where slug = j.client_slug;
  select * into ch from operator_channels where id = j.channel_id;
  select * into msg from operator_inbox where id = j.inbox_id;
  m := operator_mode_for(j.client_slug, 'status');
  if m = 'auto' and not operator_setting_on('operator_auto_send') then m := 'approve'; end if;
  insert into operator_outbox (client_slug, channel_id, inbox_id, job_id, text, mentions, mode, status, final_text)
  values (j.client_slug, ch.id, j.inbox_id, j.id, t, case when jsonb_typeof(p_mentions) = 'array' then p_mentions else '[]' end, m,
          case m when 'never' then 'blocked' when 'auto' then 'approved' else 'drafted' end, case when m = 'auto' then t end)
  returning id into oid;
  if m = 'never' then
    perform operator_log_job('operator', 'update.blocked', j.client_slug, j.id, jsonb_build_object('outbox_id', oid, 'reason', 'autonomy rule: never'), false);
    return 'blocked';
  elsif m = 'auto' then
    perform operator_log_job('operator', 'update.auto_approved', j.client_slug, j.id, jsonb_build_object('outbox_id', oid));
    return 'auto';
  end if;
  insert into approvals (kind, title, summary, payload)
  values ('external_action', left('Update ' || c.name || ': ' || j.title, 200), t,
          jsonb_build_object('type', 'operator_update', 'outbox_id', oid, 'job_id', j.id, 'job_title', j.title,
                             'client', c.slug, 'client_name', c.name, 'channel', ch.name, 'sender', msg.sender_name,
                             'message', left(msg.body, 800), 'message_url', coalesce(msg.url, ch.url), 'draft', t,
                             'links', coalesce(j.result -> 'links', '[]')))
  returning id into aid;
  update operator_outbox set approval_id = aid where id = oid;
  perform operator_log_job('operator', 'update.requested', j.client_slug, j.id, jsonb_build_object('outbox_id', oid, 'approval_id', aid));
  return 'approval';
end $$;

create or replace function operator_update_on_decision() returns trigger
language plpgsql security definer set search_path = public as $$
declare o operator_outbox;
begin
  if coalesce(new.payload ->> 'type', '') = 'operator_update' and old.status = 'pending' and new.status <> 'pending' then
    select * into o from operator_outbox where id = (new.payload ->> 'outbox_id')::uuid and status = 'drafted' for update;
    if o.id is null then return new; end if;
    if new.status = 'approved' then
      update operator_outbox set status = 'approved', final_text = o.text where id = o.id;
    elsif new.status = 'changes_requested' and nullif(btrim(coalesce(new.ceo_note, '')), '') is not null then
      update operator_outbox set status = 'approved', final_text = btrim(new.ceo_note) where id = o.id;
    else
      update operator_outbox set status = 'skipped', handled_at = now() where id = o.id;
    end if;
    perform operator_log_job('ceo', case new.status when 'approved' then 'update.approved' when 'changes_requested' then 'update.edited' else 'update.skipped' end,
                             o.client_slug, o.job_id, jsonb_build_object('outbox_id', o.id, 'via', new.decided_via));
  end if;
  return new;
end $$;
create trigger operator_update_decided after update of status on approvals for each row execute function operator_update_on_decision();

create or replace function operator_claim_update() returns operator_outbox
language plpgsql security definer set search_path = public as $$
declare o operator_outbox;
begin
  perform hq_guard();
  for o in update operator_outbox set status = 'failed', handled_at = now(), error = 'interrupted while sending: check the chat before sending again'
            where status = 'sending' and updated_at < now() - interval '10 minutes' returning * loop
    perform operator_log_job('operator', 'update.failed', o.client_slug, o.job_id, jsonb_build_object('outbox_id', o.id, 'error', o.error), false);
  end loop;
  for o in select * from operator_outbox where status = 'approved' order by updated_at limit 20 for update skip locked loop
    if operator_send_blocker(o.client_slug) is null then
      update operator_outbox set status = 'sending', attempts = attempts + 1 where id = o.id returning * into o;
      return o;
    end if;
  end loop;
  return null;
end $$;

create or replace function operator_update_may_send(p_outbox uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(operator_send_blocker(o.client_slug), case when o.status = 'sending' then null else 'not claimed' end)
    from operator_outbox o where o.id = p_outbox;
$$;

create or replace function operator_update_done(p_outbox uuid, p_ok boolean, p_error text default null, p_detail jsonb default '{}',
                                                p_final boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare o operator_outbox;
begin
  perform hq_guard();
  if p_ok then
    update operator_outbox set status = 'sent', handled_at = now(), error = null where id = p_outbox and status = 'sending' returning * into o;
  else
    update operator_outbox set status = case when attempts >= 3 or coalesce(p_final, false) then 'failed' else 'approved' end,
                               error = left(coalesce(p_error, 'send failed'), 1000),
                               handled_at = case when attempts >= 3 or coalesce(p_final, false) then now() end
     where id = p_outbox and status = 'sending' returning * into o;
  end if;
  if o.id is null then return 'not_sending'; end if;
  perform operator_log_job('operator', case when p_ok then 'update.done' when o.status = 'failed' then 'update.failed' else 'update.retry' end,
                           o.client_slug, o.job_id,
                           coalesce(p_detail, '{}') || jsonb_build_object('outbox_id', o.id, 'mode', o.mode, 'text', left(o.final_text, 800),
                                                                          'channel', (select name from operator_channels where id = o.channel_id),
                                                                          'url', (select url from operator_channels where id = o.channel_id),
                                                                          'error', left(p_error, 300)), p_ok);
  return o.status;
end $$;

-- ---------- QA evidence ----------
create or replace function operator_evidence_prune(p_days int default 30) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform hq_guard();
  delete from operator_evidence where created_at < now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- memory: Brain proposals ----------
-- One memory of a finished job. With HQ Brain M4 (brain_proposals exists) it is a normal brain proposal, applied to the
-- vault by hq-brain once approved; otherwise it waits in operator_memory (same approval in the inbox) until
-- operator_memory_promote() hands the approved ones over. The operator's own drafts recall both right away.
create or replace function operator_propose_memory(p_job uuid, p_kind text, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare j operator_jobs; c operator_clients; t text := btrim(coalesce(p_text, '')); mid uuid; aid uuid; pid uuid; pname text; label text;
begin
  perform hq_guard();
  select * into j from operator_jobs where id = p_job;
  if j.id is null then raise exception 'unknown job'; end if;
  select * into c from operator_clients where slug = j.client_slug;
  if c.brain_project is null then raise exception 'client % has no brain project', c.slug; end if;
  if p_kind not in ('session_note', 'decision', 'next_step') then raise exception 'bad kind %', p_kind; end if;
  if length(t) < 3 or length(t) > 2000 then raise exception 'the text must be 3 to 2000 characters'; end if;
  if (select count(*) from operator_memory where job_id = j.id) >= 10 then raise exception 'too many memories for this job'; end if;
  label := case p_kind when 'session_note' then 'session note' when 'decision' then 'decision' else 'next step' end;
  insert into operator_memory (job_id, client_slug, project_slug, kind, text) values (j.id, c.slug, c.brain_project, p_kind, t) returning id into mid;
  if to_regclass('public.brain_proposals') is not null then
    select name into pname from brain_projects where slug = c.brain_project;
    execute 'insert into brain_proposals (agent_id, project_slug, kind, text) values ($1, $2, $3, $4) returning id'
      into pid using 'operator', c.brain_project, p_kind, t;
    insert into approvals (kind, title, summary, payload)
    values ('external_action', left('Brain: ' || label || ' for ' || coalesce(pname, c.brain_project), 200), t,
            jsonb_build_object('type', 'brain_proposal', 'proposal_id', pid, 'project', c.brain_project, 'project_name', pname,
                               'kind', p_kind, 'section', null, 'text', t, 'operator_memory_id', mid, 'job_id', j.id))
    returning id into aid;
    execute 'update brain_proposals set approval_id = $1 where id = $2' using aid, pid;
    update operator_memory set approval_id = aid, brain_proposal_id = pid where id = mid;
  else
    insert into approvals (kind, title, summary, payload)
    values ('external_action', left('Memory: ' || label || ' for ' || c.name, 200), t,
            jsonb_build_object('type', 'operator_memory', 'memory_id', mid, 'project', c.brain_project, 'client', c.slug,
                               'client_name', c.name, 'kind', p_kind, 'text', t, 'job_id', j.id))
    returning id into aid;
    update operator_memory set approval_id = aid where id = mid;
  end if;
  perform operator_log_job('operator', 'memory.proposed', c.slug, j.id, jsonb_build_object('memory_id', mid, 'kind', p_kind, 'brain', pid is not null));
  return jsonb_build_object('memory_id', mid, 'approval_id', aid, 'brain_proposal_id', pid);
end $$;

-- The CEO's decision on either approval type flows to operator_memory (approve → approved, else rejected).
create or replace function operator_memory_on_decision() returns trigger
language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  if old.status = 'pending' and new.status <> 'pending' and coalesce(new.payload ->> 'type', '') in ('operator_memory', 'brain_proposal') then
    mid := nullif(coalesce(new.payload ->> 'memory_id', new.payload ->> 'operator_memory_id'), '')::uuid;
    if mid is null then return new; end if;
    update operator_memory set status = case when new.status = 'approved' then 'approved' else 'rejected' end, decided_at = coalesce(new.decided_at, now())
     where id = mid and status = 'pending';
  end if;
  return new;
end $$;
create trigger operator_memory_decided after update of status on approvals for each row execute function operator_memory_on_decision();

-- Once HQ Brain M4 is installed: approved memories that waited here become approved brain proposals (hq-brain applies them).
create or replace function operator_memory_promote() returns int
language plpgsql security definer set search_path = public as $$
declare m operator_memory; pid uuid; n int := 0;
begin
  perform hq_guard();
  if to_regclass('public.brain_proposals') is null then return 0; end if;
  for m in select * from operator_memory where status = 'approved' and brain_proposal_id is null order by created_at limit 50 for update skip locked loop
    execute 'insert into brain_proposals (agent_id, project_slug, kind, text, status, decided_at, approval_id) values ($1, $2, $3, $4, ''approved'', $5, $6) returning id'
      into pid using 'operator', m.project_slug, m.kind, m.text, coalesce(m.decided_at, now()), m.approval_id;
    update operator_memory set brain_proposal_id = pid where id = m.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- logins ----------
-- After each check. A login that was fine (or never checked) and is now signed out is a Telegram notice (once);
-- coming back is one too.
create or replace function operator_login_checked(p_client text, p_site text, p_state text, p_detail text default null) returns text
language plpgsql security definer set search_path = public as $$
declare l operator_logins;
begin
  perform hq_guard();
  if p_state not in ('ok', 'signed_out', 'error') then raise exception 'bad state %', p_state; end if;
  select * into l from operator_logins where client_slug = p_client and site = p_site for update;
  if l.site is null then raise exception 'unknown login % / %', p_client, p_site; end if;
  update operator_logins set state = p_state, detail = left(p_detail, 500), last_checked_at = now(),
                             last_ok_at = case when p_state = 'ok' then now() else last_ok_at end
   where client_slug = p_client and site = p_site;
  if p_state = 'signed_out' and l.state <> 'signed_out' then
    perform operator_log('operator', 'login.lost', p_client, null, jsonb_build_object('site', p_site, 'label', l.label, 'url', l.check_url, 'detail', left(p_detail, 300)), false);
  elsif p_state = 'ok' and l.state = 'signed_out' then
    perform operator_log('operator', 'login.restored', p_client, null, jsonb_build_object('site', p_site, 'label', l.label));
  end if;
  return p_state;
end $$;

create or replace function operator_set_login_site(p_client text, p_site text, p_label text, p_url text, p_enabled boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  if not exists (select 1 from operator_clients where slug = p_client) then raise exception 'unknown client %', p_client; end if;
  if coalesce(p_url, '') !~ '^https://[^\s]+$' then raise exception 'the check address must start with https://'; end if;
  insert into operator_logins (client_slug, site, label, check_url, enabled)
  values (p_client, lower(btrim(p_site)), left(btrim(coalesce(nullif(p_label, ''), p_site)), 80), btrim(p_url), coalesce(p_enabled, true))
  on conflict (client_slug, site) do update set label = excluded.label, check_url = excluded.check_url, enabled = excluded.enabled;
end $$;

-- ---------- API credentials ----------
-- The CEO links a Client Vault credential (an API token) to the operator for this client: the operator may then use
-- it for that platform's API. A loosening of access, so it needs a fresh 2FA step-up like vault grants.
create or replace function operator_set_credential(p_client text, p_platform text, p_credential uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c operator_clients; cr client_credentials;
begin
  perform hq_guard();
  perform ceo_step_up_guard();
  select * into c from operator_clients where slug = p_client for update;
  if c.slug is null then raise exception 'unknown client %', p_client; end if;
  if p_platform not in ('webflow', 'airtable') then raise exception 'platform must be webflow or airtable'; end if;
  if p_credential is not null then
    select * into cr from client_credentials where id = p_credential;
    if cr.id is null then raise exception 'unknown credential'; end if;
    if lower(cr.platform) <> p_platform then raise exception 'that credential is for %, not %', cr.platform, p_platform; end if;
    if cr.secret_type not in ('api_token', 'other') then raise exception 'the operator needs an API token, not a %', cr.secret_type; end if;
    if c.client_id is not null and cr.client_id <> c.client_id then raise exception 'that credential belongs to another client'; end if;
  end if;
  if p_platform = 'webflow' then update operator_clients set webflow_credential = p_credential where slug = p_client;
  else update operator_clients set airtable_credential = p_credential where slug = p_client; end if;
  perform operator_log('ceo', 'credential.linked', p_client, null, jsonb_build_object('platform', p_platform, 'linked', p_credential is not null));
end $$;

-- The sealed token for one platform of a client (service role only; decrypted in the operator with the vault key).
-- Every use is in credential_access_log.
create or replace function operator_credential(p_client text, p_platform text)
returns table (id uuid, platform text, label text, secret_cipher bytea, secret_iv bytea, key_version int, url_allowlist text[])
language plpgsql security definer set search_path = public as $$
declare cid uuid; cr client_credentials;
begin
  perform vault_service_guard();
  select case p_platform when 'webflow' then webflow_credential when 'airtable' then airtable_credential end into cid
    from operator_clients where slug = p_client;
  if cid is null then return; end if;
  select * into cr from client_credentials where client_credentials.id = cid;
  if cr.id is null or cr.status in ('revoked', 'check_needed') or cr.failed_login_count >= 2 then
    insert into credential_access_log (credential_id, agent_id, action, success, detail)
    values (cid, 'operator', 'api_call', false, jsonb_build_object('client', p_client, 'platform', p_platform, 'reason', coalesce(cr.status, 'missing')));
    return;
  end if;
  insert into credential_access_log (credential_id, agent_id, action, success, detail)
  values (cr.id, 'operator', 'api_call', true, jsonb_build_object('client', p_client, 'platform', p_platform));
  update client_credentials set last_used_at = now() where client_credentials.id = cr.id;
  return query select cr.id, cr.platform, cr.label, cr.secret_cipher, cr.secret_iv, cr.key_version, cr.url_allowlist;
end $$;

-- ---------- /status <client>: jobs and logins too ----------
create or replace function operator_client_status(p_client text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c operator_clients;
begin
  perform hq_guard();
  select * into c from operator_clients where slug = p_client;
  if c.slug is null then return null; end if;
  return jsonb_build_object(
    'client', to_jsonb(c) - 'rules' - 'webflow_credential' - 'airtable_credential',
    'blocker', operator_send_blocker(c.slug),
    'auto_send', operator_setting_on('operator_auto_send'),
    'counts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from operator_inbox
                          where client_slug = c.slug and created_at > now() - interval '7 days' group by status) s), '{}'),
    'channels', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'enabled', enabled, 'last_polled_at', last_polled_at, 'last_error', last_error) order by name)
                            from operator_channels where client_slug = c.slug), '[]'),
    'jobs', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'status', status, 'updated_at', updated_at) order by updated_at desc)
                        from (select * from operator_jobs where client_slug = c.slug
                               and (status not in ('done', 'cancelled', 'failed', 'escalated') or updated_at > now() - interval '2 days')
                               order by updated_at desc limit 8) x), '[]'),
    'logins', coalesce((select jsonb_agg(jsonb_build_object('site', site, 'label', label, 'state', state, 'last_checked_at', last_checked_at) order by site)
                          from operator_logins where client_slug = c.slug and enabled), '[]'),
    'last_action', (select jsonb_build_object('action', action, 'at', created_at, 'ok', ok) from operator_actions
                     where client_slug = c.slug order by id desc limit 1));
end $$;

-- ---------- grants ----------
do $$
declare f text;
begin
  foreach f in array array['operator_log_job(text,text,text,uuid,jsonb,boolean)',
                           'operator_queue_job(text,text,text,text,jsonb,uuid,uuid)', 'operator_claim_job()',
                           'operator_job_step(uuid,text,jsonb,boolean)', 'operator_request_action(uuid,text,text,jsonb)',
                           'operator_job_maybe_resume(uuid)', 'operator_claim_action()', 'operator_action_may_run(uuid)',
                           'operator_action_done(uuid,boolean,jsonb,text)', 'operator_job_run_done(uuid,text,jsonb,numeric,text)',
                           'operator_job_verified(uuid,boolean,jsonb,text)', 'operator_queue_update(uuid,text,jsonb)',
                           'operator_claim_update()', 'operator_update_may_send(uuid)',
                           'operator_update_done(uuid,boolean,text,jsonb,boolean)', 'operator_evidence_prune(int)',
                           'operator_propose_memory(uuid,text,text)', 'operator_login_checked(text,text,text,text)',
                           'operator_credential(text,text)',
                           'operator_on_decision()', 'operator_action_on_decision()', 'operator_update_on_decision()',
                           'operator_memory_on_decision()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['operator_add_job(text,text,uuid,text)', 'operator_cancel_job(uuid,text)', 'operator_memory_promote()',
                           'operator_set_login_site(text,text,text,text,boolean)', 'operator_set_credential(text,text,uuid)',
                           'operator_client_status(text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ---------- LvlUp: the sites whose logins the workspace keeps ----------
insert into operator_logins (client_slug, site, label, check_url)
select 'lvlup', s.site, s.label, s.url
  from (values ('google', 'Google (Chat)', 'https://chat.google.com/'),
               ('webflow', 'Webflow', 'https://webflow.com/dashboard'),
               ('airtable', 'Airtable', 'https://airtable.com/')) as s(site, label, url)
 where exists (select 1 from operator_clients where slug = 'lvlup')
on conflict (client_slug, site) do nothing;
