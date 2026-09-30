-- HQ Brain M14.4 (docs/16-BRAIN.md "Agents on the brain"): the six agents read the CEO's memory vault, scoped per role
-- and task, and write only PROPOSALS that the CEO approves. The worker never talks to the brain service: it calls these
-- service-only functions over Supabase. Approved proposals are applied to the vault by the brain service (hq-brain), as
-- a commit by agent:<id>. Every scope check lives here, so a prompt-injected agent cannot widen what it sees.
--
--   brain_agent_access   per agent: read_scope ('all' = every project, 'task_project' = only its task's project) and
--                        the proposal kinds it may make. Defaults (plan §5): COO reads all, proposes decisions / next
--                        steps / facts; web-dev, designer, writer: their project, session notes; QA: lessons;
--                        sales: its project, lead notes + facts.
--   brain_proposals      pending → approved/rejected (the CEO, through the normal Approvals inbox / Telegram) →
--                        applying → applied/failed (hq-brain).

-- ---------- which vault project a client is ----------
alter table clients add column if not exists brain_project_slug text
  check (brain_project_slug is null or brain_project_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$');

-- Explicit mapping, else the same slug, else a project whose name or alias is the client's name or slug.
create or replace function brain_project_for_client(p_client uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(
    c.brain_project_slug,
    (select p.slug from brain_projects p where p.listed and p.slug = c.slug),
    (select p.slug from brain_projects p
      where p.listed and (lower(p.name) = lower(c.name)
                          or exists (select 1 from unnest(p.aliases) a where lower(a) in (lower(c.name), lower(c.slug))))
      order by p.slug limit 1))
  from clients c where c.id = p_client;
$$;

-- ---------- per-agent access ----------
create table brain_agent_access (
  agent_id   text primary key references agents(id) on delete cascade,
  read_scope text not null check (read_scope in ('all', 'task_project')),
  propose    text[] not null default '{}' check (propose <@ array['decision', 'next_step', 'fact', 'lesson', 'session_note', 'lead_note']),
  updated_at timestamptz not null default now()
);
insert into brain_agent_access (agent_id, read_scope, propose)
select a.id, d.read_scope, d.propose
  from agents a
  join (values ('coo', 'all', array['decision', 'next_step', 'fact']),
               ('web-dev', 'task_project', array['session_note']),
               ('designer', 'task_project', array['session_note']),
               ('writer', 'task_project', array['session_note']),
               ('qa-lead', 'task_project', array['lesson']),
               ('sales', 'task_project', array['lead_note', 'fact'])) as d(agent_id, read_scope, propose) on d.agent_id = a.id
on conflict (agent_id) do nothing;

-- ---------- proposals ----------
create table brain_proposals (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  agent_id     text not null,
  task_id      uuid references tasks(id) on delete set null,
  request_id   uuid references requests(id) on delete set null,
  approval_id  uuid references approvals(id) on delete set null,
  project_slug text not null check (project_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  kind         text not null check (kind in ('decision', 'next_step', 'fact', 'lesson', 'session_note', 'lead_note')),
  section      text,
  text         text not null check (length(text) between 3 and 2000),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'applying', 'applied', 'failed')),
  ceo_note     text,
  decided_at   timestamptz,
  applied_at   timestamptz,
  applied_sha  text,
  error        text
);
create index brain_proposals_status on brain_proposals (status, created_at);
create index brain_proposals_task on brain_proposals (task_id);

do $$
declare t text;
begin
  foreach t in array array['brain_agent_access', 'brain_proposals'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy ceo_read on %I for select to authenticated using (is_ceo())', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;

-- ---------- scope ----------
-- The agent, its access row, and the project its task (or, for planning, the given client) maps to.
-- A task id must belong to that agent (QA: a task in review): an agent can never read through someone else's task.
create or replace function brain_agent_scope(p_agent text, p_task uuid, p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare acc brain_agent_access; tk tasks; client uuid := p_client;
begin
  select * into acc from brain_agent_access where agent_id = p_agent;
  if acc.agent_id is null then raise exception 'agent % has no brain access', p_agent using errcode = '42501'; end if;
  if p_task is not null then
    select * into tk from tasks where id = p_task;
    -- QA reviews other agents' tasks: it may use a task that is waiting for or in QA review.
    if tk.id is null or not (tk.agent_id = p_agent or (p_agent = 'qa-lead' and tk.status in ('qa_pending', 'qa_reviewing'))) then
      raise exception 'task is not assigned to %', p_agent using errcode = '42501';
    end if;
    client := tk.client_id;
  end if;
  return jsonb_build_object('agent', p_agent, 'read_scope', acc.read_scope, 'propose', to_jsonb(acc.propose),
                            'task_id', tk.id, 'request_id', tk.request_id,
                            'project', case when client is null then null else brain_project_for_client(client) end);
end $$;

-- What agents may read: curated memory, not Julev's profile or raw Claude Code transcripts.
create or replace function brain_agent_kinds() returns jsonb language sql immutable set search_path = public as $$
  select '["memory", "session", "session_log", "project_doc"]'::jsonb;
$$;

-- The auto-loaded "project memory" block of a task prompt: memory.md, open next steps, recent decisions, newest session.
create or replace function brain_agent_context(p_agent text, p_task uuid, p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare sc jsonb := brain_agent_scope(p_agent, p_task, p_client); v_slug text := sc ->> 'project'; pr brain_projects;
begin
  if v_slug is null then return jsonb_build_object('project', null, 'scope', sc); end if;
  select * into pr from brain_projects p where p.slug = v_slug and p.listed;
  if pr.slug is null then return jsonb_build_object('project', null, 'scope', sc); end if;
  return jsonb_build_object(
    'project', pr.slug, 'name', pr.name, 'status', pr.status, 'last_activity', pr.last_activity, 'scope', sc,
    'memory', (select left(body, 6000) from brain_documents where project_slug = pr.slug and kind = 'memory' order by path limit 1),
    'next_steps', coalesce((select jsonb_agg(text order by ord) from brain_next_steps where project_slug = pr.slug and not done), '[]'),
    'decisions', coalesce((select jsonb_agg(jsonb_build_object('date', decided_on, 'text', text) order by decided_on desc nulls last, ord desc)
                             from (select * from brain_decisions where project_slug = pr.slug order by decided_on desc nulls last, ord desc limit 8) d), '[]'),
    'session', (select jsonb_build_object('title', title, 'date', doc_date, 'body', left(body, 2000))
                  from brain_documents where project_slug = pr.slug and kind = 'session' order by doc_date desc nulls last, path desc limit 1));
end $$;

-- Search, limited to what this agent may see. 'task_project' agents always search their task's project only.
create or replace function brain_agent_search(p_agent text, p_task uuid, p_query text, p_project text default null, p_limit int default 8)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare sc jsonb := brain_agent_scope(p_agent, p_task); proj text;
begin
  if sc ->> 'read_scope' = 'all' then
    proj := case when p_project is not null and exists (select 1 from brain_projects where slug = p_project and listed) then p_project
                 when p_project is null then null else '__none__' end;
  else
    proj := coalesce(sc ->> 'project', '__none__');
  end if;
  if proj = '__none__' then return '[]'::jsonb; end if;
  return brain_search(p_query, null, proj, brain_agent_kinds(), greatest(1, least(coalesce(p_limit, 8), 20)));
end $$;

create or replace function brain_agent_get(p_agent text, p_task uuid, p_path text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare sc jsonb := brain_agent_scope(p_agent, p_task); d brain_documents;
begin
  select * into d from brain_documents where path = p_path;
  if d.id is null or not (brain_agent_kinds() ? d.kind) then return null; end if;
  if sc ->> 'read_scope' <> 'all' and d.project_slug is distinct from sc ->> 'project' then return null; end if;
  return jsonb_build_object('path', d.path, 'project', d.project_slug, 'kind', d.kind, 'title', d.title, 'date', d.doc_date, 'body', left(d.body, 20000));
end $$;

-- An agent proposes a memory. Becomes a normal approval (kind external_action, payload.type 'brain_proposal': not
-- high-risk, so Telegram can approve it; never pauses the task). At most 10 pending per task.
create or replace function brain_agent_propose(p_agent text, p_task uuid, p_kind text, p_text text,
                                               p_project text default null, p_section text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare sc jsonb := brain_agent_scope(p_agent, p_task); proj text; body text := btrim(coalesce(p_text, ''));
        sec text := nullif(btrim(coalesce(p_section, '')), ''); pid uuid; aid uuid; label text; pname text;
begin
  if p_task is null then raise exception 'a task is required'; end if;
  if not (sc -> 'propose' ? p_kind) then raise exception '% may not propose a %', p_agent, p_kind using errcode = '42501'; end if;
  if length(body) < 3 or length(body) > 2000 then raise exception 'the text must be 3 to 2000 characters'; end if;
  if sc ->> 'read_scope' = 'all' and p_project is not null then
    select slug into proj from brain_projects where slug = p_project and listed;
    if proj is null then raise exception 'unknown project %', p_project; end if;
  else
    proj := sc ->> 'project';
  end if;
  if proj is null and p_kind = 'lead_note' then select slug into proj from brain_projects where slug = 'inbox' and listed; end if;
  if proj is null then raise exception 'this task''s client is not a project in the brain'; end if;
  if (select count(*) from brain_proposals where task_id = p_task and status = 'pending') >= 10 then
    raise exception 'too many pending proposals for this task';
  end if;
  if p_kind = 'fact' then sec := coalesce(sec, 'Notes'); else sec := null; end if;
  if sec is not null and sec !~ '^[A-Za-z][A-Za-z /&-]{0,39}$' then raise exception 'bad section name'; end if;
  select name into pname from brain_projects where slug = proj;
  label := case p_kind when 'decision' then 'decision' when 'next_step' then 'next step' when 'fact' then 'fact'
                       when 'lesson' then 'lesson' when 'session_note' then 'session note' else 'lead note' end;
  insert into brain_proposals (agent_id, task_id, request_id, project_slug, kind, section, text)
  values (p_agent, p_task, (sc ->> 'request_id')::uuid, proj, p_kind, sec, body) returning id into pid;
  insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
  values ('external_action', (sc ->> 'request_id')::uuid, p_task, p_agent, left('Brain: ' || label || ' for ' || coalesce(pname, proj), 200), body,
          jsonb_build_object('type', 'brain_proposal', 'proposal_id', pid, 'project', proj, 'project_name', pname,
                             'kind', p_kind, 'section', sec, 'text', body))
  returning id into aid;
  update brain_proposals set approval_id = aid where id = pid;
  perform hq_log(p_agent, 'brain.proposed', (sc ->> 'request_id')::uuid, p_task, jsonb_build_object('proposal_id', pid, 'kind', p_kind, 'project', proj));
  return jsonb_build_object('proposal_id', pid, 'approval_id', aid, 'project', proj);
end $$;

-- The CEO's decision on the approval flows to the proposal (approve → approved; changes / reject → rejected).
create or replace function brain_proposal_on_decision() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if coalesce(new.payload ->> 'type', '') = 'brain_proposal' and old.status = 'pending' and new.status <> 'pending' then
    update brain_proposals set
      status = case when new.status = 'approved' then 'approved' else 'rejected' end,
      decided_at = coalesce(new.decided_at, now()), ceo_note = new.ceo_note
    where id = (new.payload ->> 'proposal_id')::uuid and status = 'pending';
  end if;
  return new;
end $$;
create trigger brain_proposal_decided after update of status on approvals for each row execute function brain_proposal_on_decision();

-- A pending brain proposal does not make its agent "waiting": the task keeps going (same as before otherwise).
create or replace function refresh_agent_status(p_agent text) returns agent_status
language plpgsql security definer set search_path = public as $$
declare s agent_status; cur_task uuid;
begin
  select case
    when not a.enabled then 'offline'::agent_status
    when exists (select 1 from tasks t where t.agent_id = a.id and t.status in ('working','qa_reviewing')) then 'working'
    when exists (select 1 from approvals ap where ap.agent_id = a.id and ap.status = 'pending'
                   and coalesce(ap.payload ->> 'type', '') <> 'brain_proposal') then 'waiting'
    when exists (select 1 from tasks t join requests r on r.id = t.request_id
                 where t.agent_id = a.id and t.status = 'failed' and r.status = 'in_progress') then 'blocked'
    else 'idle' end
  into s from agents a where a.id = p_agent;
  if s is null then return null; end if;

  select t.id into cur_task from tasks t
   where t.agent_id = p_agent and t.status in ('working','qa_reviewing') order by t.updated_at desc limit 1;

  update agents set
    status = s,
    current_task_id = cur_task,
    idle_activity = case when s = 'idle' then idle_activity else null end,
    idle_since = case when s = 'idle' and status <> 'idle' then now() when s <> 'idle' then null else idle_since end
  where id = p_agent;
  return s;
end $$;

-- ---------- hq-brain applies approved proposals ----------
-- Claims up to p_limit approved proposals (and re-claims ones stuck in 'applying' for 10 minutes).
create or replace function brain_proposals_claim(p_limit int default 10) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare out jsonb;
begin
  with c as (
    select id from brain_proposals
     where status = 'approved' or (status = 'applying' and applied_at < now() - interval '10 minutes')
     order by decided_at nulls first, created_at limit greatest(1, least(coalesce(p_limit, 10), 50)) for update skip locked
  ), u as (
    update brain_proposals p set status = 'applying', applied_at = now() from c where p.id = c.id returning p.*
  )
  select coalesce(jsonb_agg(to_jsonb(u) order by u.created_at), '[]'::jsonb) into out from u;
  return out;
end $$;

create or replace function brain_proposal_done(p_id uuid, p_sha text, p_error text default null) returns void
language sql security definer set search_path = public, extensions as $$
  update brain_proposals set status = case when p_error is null then 'applied' else 'failed' end,
    applied_at = now(), applied_sha = left(p_sha, 64), error = left(p_error, 1000)
  where id = p_id and status = 'applying';
$$;

-- ---------- CEO API ----------
create or replace function brain_list_proposals(p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform hq_guard();
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc)
                     from (select p.*, (select name from agents where id = p.agent_id) as agent_name,
                                  (select name from brain_projects where slug = p.project_slug) as project_name
                             from brain_proposals p order by p.created_at desc
                            limit greatest(1, least(coalesce(p_limit, 50), 200))) x), '[]'::jsonb);
end $$;

-- Daily digest "Brain" section: what changed since p_since.
create or replace function brain_digest_facts(p_since timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform hq_guard();
  return jsonb_build_object(
    'saves', (select count(*) from brain_events where ts >= p_since and action in ('saved', 'doc_added', 'doc_changed')),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('slug', x.project_slug, 'name', coalesce(bp.name, x.project_slug), 'changes', x.n) order by x.n desc)
                            from (select project_slug, count(*) n from brain_events
                                   where ts >= p_since and project_slug is not null and action in ('saved', 'doc_added', 'doc_changed')
                                   group by project_slug order by count(*) desc limit 6) x
                            left join brain_projects bp on bp.slug = x.project_slug), '[]'::jsonb),
    'proposals_pending', (select count(*) from brain_proposals where status = 'pending'),
    'proposals_applied', (select count(*) from brain_proposals where status = 'applied' and applied_at >= p_since),
    'proposals_failed', (select count(*) from brain_proposals where status = 'failed' and applied_at >= p_since));
end $$;

-- ---------- grants ----------
do $$
declare f text;
begin
  foreach f in array array['brain_list_proposals(int)', 'brain_digest_facts(timestamptz)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array['brain_project_for_client(uuid)', 'brain_agent_scope(text, uuid, uuid)', 'brain_agent_kinds()',
                           'brain_agent_context(text, uuid, uuid)', 'brain_agent_search(text, uuid, text, text, int)',
                           'brain_agent_get(text, uuid, text)', 'brain_agent_propose(text, uuid, text, text, text, text)',
                           'brain_proposal_on_decision()', 'brain_proposals_claim(int)', 'brain_proposal_done(uuid, text, text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
