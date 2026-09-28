-- RizeHub HQ · workflow engine (docs/05-ORCHESTRATION.md)
-- All state transitions live here so the dashboard, bot and worker share one set of rules.
-- Callers: dashboard (CEO, authenticated) → create_request, decide_approval
--          worker (service role)          → submit_plan, submit_task_output, claim_qa_review,
--                                            record_qa_verdict, ask_ceo, fail_task, report_progress

-- ---------- access guard ----------
-- CEO session, the service role (worker/bot), or a direct DB session (migrations/tests: no JWT at all).
create or replace function hq_can_operate() returns boolean
language sql stable security definer set search_path = public as $$
  select is_ceo()
      or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
      or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      or (auth.uid() is null and coalesce(current_setting('request.jwt.claim.role', true), '') = ''
          and coalesce(auth.jwt() ->> 'role', '') = '');
$$;

create or replace function hq_guard() returns void language plpgsql as $$
begin
  if not hq_can_operate() then raise exception 'not allowed' using errcode = '42501'; end if;
end $$;

create or replace function hq_log(p_actor text, p_action text, p_request uuid, p_task uuid, p_detail jsonb default '{}')
returns void language sql security definer set search_path = public as $$
  insert into activity_log (actor, action, request_id, task_id, detail) values (p_actor, p_action, p_request, p_task, coalesce(p_detail, '{}'));
$$;

-- ---------- agent status (drives the office) ----------
create or replace function refresh_agent_status(p_agent text) returns agent_status
language plpgsql security definer set search_path = public as $$
declare s agent_status; cur_task uuid;
begin
  select case
    when not a.enabled then 'offline'::agent_status
    when exists (select 1 from tasks t where t.agent_id = a.id and t.status in ('working','qa_reviewing')) then 'working'
    when exists (select 1 from approvals ap where ap.agent_id = a.id and ap.status = 'pending') then 'waiting'
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

-- ---------- 1. intake ----------
create or replace function create_request(p_source text, p_raw_text text, p_priority text default 'normal',
                                          p_due_date date default null, p_client_slug text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; cid uuid;
begin
  perform hq_guard();
  if coalesce(trim(p_raw_text), '') = '' then raise exception 'request text is empty'; end if;
  if p_client_slug is not null then select id into cid from clients where slug = p_client_slug; end if;
  insert into requests (source, raw_text, priority, due_date, client_id)
  values (p_source, trim(p_raw_text), coalesce(p_priority, 'normal'), p_due_date, cid)
  returning id into rid;
  perform hq_log('ceo', 'request.created', rid, null, jsonb_build_object('source', p_source, 'client_slug', p_client_slug));
  return rid;
end $$;

-- Worker picks staged requests for the COO (skip locked so two workers never plan the same one).
create or replace function claim_request_for_planning() returns requests
language plpgsql security definer set search_path = public as $$
declare r requests;
begin
  perform hq_guard();
  select * into r from requests where status = 'staged' order by
    case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, created_at
  for update skip locked limit 1;
  if r.id is null then return null; end if;
  update requests set status = 'planning' where id = r.id returning * into r;
  update agents set status = 'working', idle_activity = null where id = 'coo';
  return r;
end $$;

-- ---------- 2. COO plan ----------
-- p_plan is the validated Plan JSON (packages/shared/src/schemas.ts).
create or replace function submit_plan(p_request uuid, p_plan jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare aid uuid; t jsonb; keys text[] := '{}'; d text; n int; cid uuid;
begin
  perform hq_guard();
  if jsonb_typeof(p_plan -> 'tasks') <> 'array' or jsonb_array_length(p_plan -> 'tasks') = 0 then
    raise exception 'plan has no tasks';
  end if;
  for t in select * from jsonb_array_elements(p_plan -> 'tasks') loop
    if not exists (select 1 from agents where id = t ->> 'agent_id' and enabled) then
      raise exception 'plan uses unknown or disabled agent %', t ->> 'agent_id';
    end if;
    if (t ->> 'key') = any(keys) then raise exception 'duplicate task key %', t ->> 'key'; end if;
    keys := keys || (t ->> 'key');
  end loop;
  for t in select * from jsonb_array_elements(p_plan -> 'tasks') loop
    for d in select jsonb_array_elements_text(coalesce(t -> 'depends_on', '[]')) loop
      if not d = any(keys) then raise exception 'task % depends on unknown task %', t ->> 'key', d; end if;
    end loop;
  end loop;

  if p_plan ->> 'client_slug' is not null then select id into cid from clients where slug = p_plan ->> 'client_slug'; end if;
  n := jsonb_array_length(p_plan -> 'tasks');

  update requests set
    title = coalesce(p_plan ->> 'title', title),
    brief = p_plan,
    client_id = coalesce(client_id, cid),
    priority = coalesce(p_plan ->> 'priority', priority),
    due_date = coalesce(due_date, nullif(p_plan ->> 'due_date', '')::date),
    status = 'plan_review'
  where id = p_request and status in ('planning', 'staged');
  if not found then raise exception 'request % is not being planned', p_request; end if;

  insert into approvals (kind, request_id, agent_id, title, summary, payload)
  values ('plan', p_request, 'coo', 'Plan: ' || coalesce(p_plan ->> 'title', 'Untitled'),
          n || ' task' || case when n = 1 then '' else 's' end
            || coalesce(' · est. $' || (p_plan ->> 'estimated_cost_usd'), '')
            || coalesce(' · due ' || (p_plan ->> 'due_date'), ''),
          p_plan)
  returning id into aid;
  perform refresh_agent_status('coo');
  perform hq_log('coo', 'plan.submitted', p_request, null, jsonb_build_object('approval_id', aid, 'tasks', n));
  return aid;
end $$;

-- ---------- 3. CEO decisions ----------
-- p_decision: 'approve' | 'changes' | 'reject'. p_note is required for 'changes'.
create or replace function decide_approval(p_approval uuid, p_decision text, p_note text default null, p_via text default 'dashboard')
returns text language plpgsql security definer set search_path = public as $$
declare ap approvals; t jsonb; keymap jsonb := '{}'; new_id uuid; deps uuid[]; rq requests; tk tasks;
        new_status approval_status; result text;
begin
  perform hq_guard();
  if p_decision not in ('approve', 'changes', 'reject') then raise exception 'bad decision %', p_decision; end if;
  if p_decision = 'changes' and coalesce(trim(p_note), '') = '' then raise exception 'say what should change'; end if;

  select * into ap from approvals where id = p_approval for update;
  if ap.id is null then raise exception 'approval not found'; end if;
  if ap.status <> 'pending' then return 'already_' || ap.status; end if;

  new_status := case p_decision when 'approve' then 'approved' when 'changes' then 'changes_requested' else 'rejected' end;
  update approvals set status = new_status, ceo_note = p_note, decided_at = now(), decided_via = p_via where id = ap.id;

  if ap.kind = 'plan' then
    select * into rq from requests where id = ap.request_id for update;
    if p_decision = 'approve' then
      for t in select * from jsonb_array_elements(ap.payload -> 'tasks') loop
        keymap := keymap || jsonb_build_object(t ->> 'key', gen_random_uuid());
      end loop;
      for t in select * from jsonb_array_elements(ap.payload -> 'tasks') loop
        select coalesce(array_agg((keymap ->> k)::uuid), '{}') into deps
          from jsonb_array_elements_text(coalesce(t -> 'depends_on', '[]')) k;
        insert into tasks (id, request_id, client_id, agent_id, title, instructions, work_type, acceptance_criteria, depends_on, status)
        values ((keymap ->> (t ->> 'key'))::uuid, rq.id, rq.client_id, t ->> 'agent_id', t ->> 'title',
                coalesce(t ->> 'instructions', ''), t ->> 'work_type', coalesce(t -> 'acceptance_criteria', '[]'), deps, 'pending');
      end loop;
      update requests set status = 'in_progress' where id = rq.id;
      perform release_ready_tasks(rq.id);
      result := 'plan_approved';
    elsif p_decision = 'changes' then
      -- COO re-plans with the CEO's note.
      update requests set status = 'staged',
        brief = coalesce(brief, '{}') || jsonb_build_object('ceo_feedback', coalesce(brief -> 'ceo_feedback', '[]') || to_jsonb(p_note))
      where id = rq.id;
      result := 'replan';
    else
      update requests set status = 'rejected' where id = rq.id;
      result := 'plan_rejected';
    end if;

  elsif ap.kind = 'deliverable' then
    select * into tk from tasks where id = ap.task_id for update;
    if p_decision = 'approve' then
      update tasks set status = 'done', completed_at = now() where id = tk.id;
      perform release_ready_tasks(tk.request_id);
      result := 'task_done';
    elsif p_decision = 'changes' then
      update tasks set status = 'queued', revision_count = revision_count + 1,
        qa_feedback = jsonb_build_object('source', 'ceo', 'fix_list', jsonb_build_array(p_note))
      where id = tk.id;
      result := 'task_revision';
    else
      update tasks set status = 'cancelled' where id = tk.id;
      result := 'task_cancelled';
    end if;
    -- Close the request when nothing is left open.
    if not exists (select 1 from tasks where request_id = tk.request_id and status not in ('done', 'cancelled')) then
      update requests set status = case when exists (select 1 from tasks where request_id = tk.request_id and status = 'done')
                                        then 'done'::request_status else 'cancelled'::request_status end
      where id = tk.request_id and status = 'in_progress';
    end if;

  else -- external_action (incl. agent questions and QA escalations)
    if ap.task_id is not null then
      select * into tk from tasks where id = ap.task_id for update;
      if tk.status in ('awaiting_ceo', 'failed') then
        if p_decision = 'reject' and coalesce(ap.payload ->> 'type', '') = 'qa_escalation' then
          update tasks set status = 'cancelled' where id = tk.id;
        else
          -- Resume the task with the CEO's answer; the worker executes approved actions itself.
          update tasks set status = 'queued',
            qa_feedback = coalesce(qa_feedback, '{}') || jsonb_build_object('ceo_decision', p_decision, 'ceo_note', p_note)
          where id = tk.id;
        end if;
      end if;
    end if;
    result := 'action_' || new_status;
  end if;

  if ap.agent_id is not null then perform refresh_agent_status(ap.agent_id); end if;
  if tk.agent_id is not null then perform refresh_agent_status(tk.agent_id); end if;
  perform hq_log('ceo', 'approval.' || new_status, ap.request_id, ap.task_id,
                 jsonb_build_object('approval_id', ap.id, 'kind', ap.kind, 'via', p_via, 'note', p_note));
  return result;
end $$;

-- ---------- 4. agents at work ----------
create or replace function report_progress(p_task uuid, p_percent int, p_note text, p_screen jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare tk tasks;
begin
  perform hq_guard();
  update tasks set heartbeat_at = now() where id = p_task returning * into tk;
  if tk.id is null then raise exception 'task not found'; end if;
  insert into agent_screens (agent_id, task_id, app, title, content, image_url, step_note, progress, updated_at)
  values (tk.agent_id, tk.id, coalesce(p_screen ->> 'app', 'editor'), p_screen ->> 'title', left(p_screen ->> 'content', 4000),
          p_screen ->> 'image_url', p_note, greatest(0, least(100, p_percent)), now())
  on conflict (agent_id) do update set task_id = excluded.task_id, app = excluded.app,
    title = coalesce(excluded.title, agent_screens.title), content = coalesce(excluded.content, agent_screens.content),
    image_url = coalesce(excluded.image_url, agent_screens.image_url), step_note = excluded.step_note,
    progress = excluded.progress, updated_at = now();
end $$;

create or replace function submit_task_output(p_task uuid, p_output jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare tk tasks;
begin
  perform hq_guard();
  update tasks set output = p_output, status = 'qa_pending', heartbeat_at = now()
   where id = p_task and status = 'working' returning * into tk;
  if tk.id is null then raise exception 'task % is not in progress', p_task; end if;
  perform refresh_agent_status(tk.agent_id);
  perform hq_log(tk.agent_id, 'task.submitted', tk.request_id, tk.id, jsonb_build_object('summary', p_output ->> 'summary'));
end $$;

create or replace function ask_ceo(p_task uuid, p_question text, p_options jsonb default '[]') returns uuid
language plpgsql security definer set search_path = public as $$
declare tk tasks; aid uuid;
begin
  perform hq_guard();
  update tasks set status = 'awaiting_ceo' where id = p_task and status = 'working' returning * into tk;
  if tk.id is null then raise exception 'task % is not in progress', p_task; end if;
  insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
  values ('external_action', tk.request_id, tk.id, tk.agent_id, 'Question: ' || left(p_question, 80), p_question,
          jsonb_build_object('type', 'question', 'question', p_question, 'options', p_options))
  returning id into aid;
  perform refresh_agent_status(tk.agent_id);
  return aid;
end $$;

create or replace function fail_task(p_task uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare tk tasks;
begin
  perform hq_guard();
  update tasks set status = 'failed' where id = p_task and status not in ('done', 'cancelled') returning * into tk;
  if tk.id is null then return; end if;
  insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
  values ('external_action', tk.request_id, tk.id, tk.agent_id, 'Stuck: ' || tk.title, p_reason,
          jsonb_build_object('type', 'task_failed', 'reason', p_reason, 'options', jsonb_build_array('retry', 'cancel')));
  perform refresh_agent_status(tk.agent_id);
  perform hq_log(tk.agent_id, 'task.failed', tk.request_id, tk.id, jsonb_build_object('reason', p_reason));
end $$;

-- ---------- 5. QA ----------
create or replace function claim_qa_review() returns tasks
language plpgsql security definer set search_path = public as $$
declare tk tasks;
begin
  perform hq_guard();
  select * into tk from tasks where status = 'qa_pending' order by updated_at for update skip locked limit 1;
  if tk.id is null then return null; end if;
  update tasks set status = 'qa_reviewing' where id = tk.id returning * into tk;
  update agents set status = 'working', idle_activity = null where id = 'qa-lead';
  return tk;
end $$;

-- p_verdict follows the QaVerdict schema. Pass = verdict 'pass' AND score ≥ threshold AND every check passed.
create or replace function record_qa_verdict(p_task uuid, p_reviewer text, p_verdict jsonb, p_threshold int default 85)
returns text language plpgsql security definer set search_path = public as $$
declare tk tasks; passed boolean; failed_checks jsonb; result text;
begin
  perform hq_guard();
  select * into tk from tasks where id = p_task for update;
  if tk.id is null or tk.status <> 'qa_reviewing' then raise exception 'task % is not under QA', p_task; end if;

  passed := (p_verdict ->> 'verdict') = 'pass'
        and coalesce((p_verdict ->> 'score')::int, 0) >= p_threshold
        and not exists (select 1 from jsonb_array_elements(coalesce(p_verdict -> 'checks', '[]')) c where c ->> 'result' <> 'pass');
  select coalesce(jsonb_agg(c), '[]') into failed_checks
    from jsonb_array_elements(coalesce(p_verdict -> 'checks', '[]')) c where c ->> 'result' <> 'pass';

  insert into qa_reviews (task_id, reviewer_id, attempt, verdict, score, checks, summary, evidence_urls)
  values (tk.id, p_reviewer, tk.revision_count + 1, case when passed then 'pass' else 'fail' end,
          (p_verdict ->> 'score')::int, coalesce(p_verdict -> 'checks', '[]'), p_verdict ->> 'summary',
          coalesce((select array_agg(c ->> 'evidence') from jsonb_array_elements(coalesce(p_verdict -> 'checks', '[]')) c
                    where c ->> 'evidence' is not null), '{}'));

  if passed then
    update tasks set status = 'awaiting_ceo', qa_feedback = null where id = tk.id;
    insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload, preview_url)
    values ('deliverable', tk.request_id, tk.id, tk.agent_id, tk.title,
            coalesce(tk.output ->> 'summary', '') || ' · QA ' || (p_verdict ->> 'score'),
            jsonb_build_object('output', tk.output, 'qa', p_verdict), tk.output ->> 'preview_url');
    result := 'pass';
  elsif tk.revision_count + 1 > tk.max_revisions then
    update tasks set status = 'failed', revision_count = revision_count + 1,
      qa_feedback = jsonb_build_object('source', 'qa', 'fix_list', coalesce(p_verdict -> 'fix_list', '[]'), 'failed_checks', failed_checks)
    where id = tk.id;
    insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
    values ('external_action', tk.request_id, tk.id, tk.agent_id, 'QA keeps failing: ' || tk.title,
            'Failed QA ' || (tk.revision_count + 1) || ' times. Accept as-is, retry with your note, or reject.',
            jsonb_build_object('type', 'qa_escalation', 'last_verdict', p_verdict, 'options', jsonb_build_array('retry', 'reject')));
    result := 'escalated';
  else
    update tasks set status = 'queued', revision_count = revision_count + 1,
      qa_feedback = jsonb_build_object('source', 'qa', 'fix_list', coalesce(p_verdict -> 'fix_list', '[]'), 'failed_checks', failed_checks)
    where id = tk.id;
    result := 'revision';
  end if;

  perform refresh_agent_status(tk.agent_id);
  perform refresh_agent_status(p_reviewer);
  perform hq_log(p_reviewer, 'qa.' || result, tk.request_id, tk.id, jsonb_build_object('score', p_verdict ->> 'score'));
  return result;
end $$;

-- Worker helper: after the worker finishes or abandons a task, recompute the agent.
create or replace function finish_agent_turn(p_agent text) returns agent_status
language sql security definer set search_path = public as $$ select refresh_agent_status(p_agent); $$;

-- Only CEO/service callers can use these (hq_guard); revoke from anonymous users entirely.
do $$
declare f text;
begin
  foreach f in array array['create_request(text,text,text,date,text)','claim_request_for_planning()','submit_plan(uuid,jsonb)',
    'decide_approval(uuid,text,text,text)','report_progress(uuid,int,text,jsonb)','submit_task_output(uuid,jsonb)',
    'ask_ceo(uuid,text,jsonb)','fail_task(uuid,text)','claim_qa_review()','record_qa_verdict(uuid,text,jsonb,int)',
    'finish_agent_turn(text)','refresh_agent_status(text)','claim_next_task()','release_ready_tasks(uuid)','requeue_stale_tasks()']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
