-- RizeHub HQ · review fixes (never edit the earlier migrations; everything here redefines on top of them).
--  1. A CEO decision resumes a task only when THAT approval paused it (tasks.paused_by_approval).
--     Pausing: ask_ceo, fail_task, QA escalation, QA stuck (7), request_rizehub_action(p_pause => true).
--     Not pausing: request_external_action, vault 2FA questions (the tool waits while the task keeps running).
--  2. Rejecting a 'task_failed' approval cancels the task; after EVERY decision the request is closed when nothing is
--     left open (tasks that can never run because a dependency was cancelled are cancelled too).
--  3. Crash recovery: claim_qa_review / claim_request_for_planning stamp a start time; requeue_stale_tasks (the worker's
--     60 s sweep) also returns qa_reviewing → qa_pending and planning → staged after 10 min and recomputes every agent
--     that still shows 'working' without work. It also scrubs 2FA codes nobody consumed.
--  4. hq_log / refresh_agent_status / finish_agent_turn / hq_guard / hq_can_operate: service role only (they run inside
--     SECURITY DEFINER functions as the owner, so CEO calls through the workflow RPCs keep working; no RLS policy uses them).
--  5. Vault 2FA: an answer is always recorded as 'approve' + code; approve without a code is refused; the code never
--     reaches activity_log, is scrubbed from the approval on every outcome (consumed, rejected, expired, task gone).
--  6. client_credentials.write_allowlist: vault_api is read-only unless "METHOD /path-prefix" matches (worker enforces).
--  7. QA that cannot produce a verdict: tasks.qa_attempts; the 3rd failure escalates to the CEO ('qa_stuck').

-- ---------- columns ----------
alter table tasks add column if not exists paused_by_approval uuid references approvals(id) on delete set null;
alter table tasks add column if not exists qa_attempts int not null default 0;
alter table requests add column if not exists planning_started_at timestamptz;
alter table client_credentials add column if not exists write_allowlist text[] not null default '{}';
grant select (write_allowlist) on client_credentials to authenticated;

-- Tasks already paused when this migration runs: link them to the approval that paused them.
update tasks t set paused_by_approval = (
  select ap.id from approvals ap
   where ap.task_id = t.id and ap.kind = 'external_action' and ap.status = 'pending' and not (ap.payload ? 'vault')
     and (ap.payload ->> 'type' in ('question', 'task_failed', 'qa_escalation')
          or (ap.payload ->> 'action_type' like 'rizehub.%'
              and not exists (select 1 from approvals d where d.task_id = t.id and d.kind = 'deliverable' and d.status = 'pending')))
   order by ap.created_at desc limit 1)
where t.status in ('awaiting_ceo', 'failed') and t.paused_by_approval is null;

-- ---------- helpers ----------
create or replace function vault_is_2fa(p approvals) returns boolean language sql immutable as $$
  select p.kind = 'external_action' and coalesce(p.payload -> 'vault' ->> 'kind', '') = '2fa';
$$;

-- Removes a 2FA code from everywhere it could have been copied to (approval note, payload, activity log, task feedback).
create or replace function vault_scrub_2fa(p_approval uuid, p_marker text) returns void
language plpgsql security definer set search_path = public as $$
declare ap approvals; code text;
begin
  select * into ap from approvals where id = p_approval;
  if ap.id is null or not vault_is_2fa(ap) then return; end if;
  code := nullif(ap.ceo_note, '');
  if code is not null and code like '[2FA %]' then code := null; end if;
  update approvals set ceo_note = case when ceo_note is null or ceo_note like '[2FA %]' then ceo_note else p_marker end,
                       payload = payload - 'code' - 'answer' - 'ceo_note'
   where id = ap.id;
  update activity_log set detail = detail || jsonb_build_object('note', p_marker)
   where detail ->> 'approval_id' = ap.id::text and detail ? 'note' and coalesce(detail ->> 'note', '') not like '[2FA %]';
  if code is not null and ap.task_id is not null then
    update tasks set qa_feedback = qa_feedback || jsonb_build_object('ceo_note', p_marker)
     where id = ap.task_id and qa_feedback ->> 'ceo_note' = code;
  end if;
end $$;

-- Pending tasks that can never run (a dependency was cancelled) are cancelled; then the request is closed when
-- nothing is left open: done if anything was delivered, cancelled otherwise.
create or replace function close_request_if_finished(p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_request is null then return; end if;
  loop
    update tasks tk set status = 'cancelled'
     where tk.request_id = p_request and tk.status = 'pending'
       and exists (select 1 from tasks d where d.id = any(tk.depends_on) and d.status = 'cancelled');
    get diagnostics n = row_count;
    exit when n = 0;
  end loop;
  if exists (select 1 from tasks where request_id = p_request)
     and not exists (select 1 from tasks where request_id = p_request and status not in ('done', 'cancelled')) then
    update requests set status = case when exists (select 1 from tasks where request_id = p_request and status = 'done')
                                      then 'done'::request_status else 'cancelled'::request_status end
    where id = p_request and status = 'in_progress';
  end if;
end $$;

-- ---------- 1. pausing functions remember their approval ----------
create or replace function ask_ceo(p_task uuid, p_question text, p_options jsonb default '[]') returns uuid
language plpgsql security definer set search_path = public as $$
declare tk tasks; aid uuid;
begin
  perform hq_guard();
  update tasks set status = 'awaiting_ceo' where id = p_task and status = 'working' returning * into tk;
  if tk.id is null then raise exception 'task % is not in progress', p_task; end if;
  insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
  values ('external_action', tk.request_id, tk.id, tk.agent_id, 'Question: ' || left(p_question, 80), p_question,
          jsonb_build_object('type', 'question', 'question', p_question, 'options', p_options, 'pauses_task', true))
  returning id into aid;
  update tasks set paused_by_approval = aid where id = tk.id;
  perform refresh_agent_status(tk.agent_id);
  return aid;
end $$;

create or replace function fail_task(p_task uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare tk tasks; aid uuid;
begin
  perform hq_guard();
  update tasks set status = 'failed' where id = p_task and status not in ('done', 'cancelled') returning * into tk;
  if tk.id is null then return; end if;
  insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
  values ('external_action', tk.request_id, tk.id, tk.agent_id, 'Stuck: ' || tk.title, p_reason,
          jsonb_build_object('type', 'task_failed', 'reason', p_reason, 'options', jsonb_build_array('retry', 'cancel'), 'pauses_task', true))
  returning id into aid;
  update tasks set paused_by_approval = aid where id = tk.id;
  perform refresh_agent_status(tk.agent_id);
  perform hq_log(tk.agent_id, 'task.failed', tk.request_id, tk.id, jsonb_build_object('reason', p_reason));
end $$;

create or replace function request_rizehub_action(p_task uuid, p_action_type text, p_spec jsonb, p_pause boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare aid uuid; tk tasks;
begin
  perform hq_guard();
  if p_action_type not like 'rizehub.%' then raise exception 'action type must start with rizehub.'; end if;
  aid := request_external_action(p_task, p_action_type, p_spec);
  if p_pause then
    update tasks set status = 'awaiting_ceo', paused_by_approval = aid where id = p_task and status = 'working' returning * into tk;
    if tk.id is not null then
      update approvals set payload = payload || jsonb_build_object('pauses_task', true) where id = aid;
      perform refresh_agent_status(tk.agent_id);
    end if;
  end if;
  return aid;
end $$;

-- ---------- 3 + 7. QA ----------
create or replace function claim_qa_review() returns tasks
language plpgsql security definer set search_path = public as $$
declare tk tasks;
begin
  perform hq_guard();
  select * into tk from tasks where status = 'qa_pending' order by updated_at for update skip locked limit 1;
  if tk.id is null then return null; end if;
  update tasks set status = 'qa_reviewing', heartbeat_at = now() where id = tk.id returning * into tk;
  update agents set status = 'working', idle_activity = null where id = 'qa-lead';
  return tk;
end $$;

create or replace function record_qa_verdict(p_task uuid, p_reviewer text, p_verdict jsonb, p_threshold int default 85)
returns text language plpgsql security definer set search_path = public as $$
declare tk tasks; passed boolean; failed_checks jsonb; result text; aid uuid;
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
    update tasks set status = 'awaiting_ceo', qa_feedback = null, qa_attempts = 0, paused_by_approval = null where id = tk.id;
    insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload, preview_url)
    values ('deliverable', tk.request_id, tk.id, tk.agent_id, tk.title,
            coalesce(tk.output ->> 'summary', '') || ' · QA ' || (p_verdict ->> 'score'),
            jsonb_build_object('output', tk.output, 'qa', p_verdict), tk.output ->> 'preview_url');
    result := 'pass';
  elsif tk.revision_count + 1 > tk.max_revisions then
    update tasks set status = 'failed', revision_count = revision_count + 1, qa_attempts = 0,
      qa_feedback = jsonb_build_object('source', 'qa', 'fix_list', coalesce(p_verdict -> 'fix_list', '[]'), 'failed_checks', failed_checks)
    where id = tk.id;
    insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
    values ('external_action', tk.request_id, tk.id, tk.agent_id, 'QA keeps failing: ' || tk.title,
            'Failed QA ' || (tk.revision_count + 1) || ' times. Accept as-is, retry with your note, or reject.',
            jsonb_build_object('type', 'qa_escalation', 'last_verdict', p_verdict, 'options', jsonb_build_array('retry', 'reject'),
                               'pauses_task', true))
    returning id into aid;
    update tasks set paused_by_approval = aid where id = tk.id;
    result := 'escalated';
  else
    update tasks set status = 'queued', revision_count = revision_count + 1, qa_attempts = 0,
      qa_feedback = jsonb_build_object('source', 'qa', 'fix_list', coalesce(p_verdict -> 'fix_list', '[]'), 'failed_checks', failed_checks)
    where id = tk.id;
    result := 'revision';
  end if;

  perform refresh_agent_status(tk.agent_id);
  perform refresh_agent_status(p_reviewer);
  perform hq_log(p_reviewer, 'qa.' || result, tk.request_id, tk.id, jsonb_build_object('score', p_verdict ->> 'score'));
  return result;
end $$;

-- QA ran but produced no valid verdict (or crashed for a non-quota reason). Returns 'retry' (back to qa_pending) or
-- 'escalated' after the 3rd failed attempt (task failed + 'qa_stuck' approval: approve = retry QA, reject = cancel).
create or replace function qa_review_failed(p_task uuid, p_reason text) returns text
language plpgsql security definer set search_path = public as $$
declare tk tasks; n int; aid uuid; reason text := left(coalesce(nullif(trim(p_reason), ''), 'no valid verdict'), 500);
begin
  perform hq_guard();
  select * into tk from tasks where id = p_task for update;
  if tk.id is null or tk.status <> 'qa_reviewing' then return 'not_under_qa'; end if;
  n := tk.qa_attempts + 1;
  if n >= 3 then
    update tasks set status = 'failed', qa_attempts = n where id = tk.id;
    insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
    values ('external_action', tk.request_id, tk.id, tk.agent_id, left('QA can''t review: ' || tk.title, 200),
            'QA could not produce a valid verdict ' || n || ' times. Approve = try QA again · Reject = cancel the task. Last error: ' || reason,
            jsonb_build_object('type', 'qa_stuck', 'reason', reason, 'attempts', n, 'options', jsonb_build_array('retry_qa', 'cancel'),
                               'pauses_task', true))
    returning id into aid;
    update tasks set paused_by_approval = aid where id = tk.id;
    perform hq_log('qa-lead', 'qa.stuck', tk.request_id, tk.id, jsonb_build_object('attempts', n, 'reason', reason, 'approval_id', aid));
  else
    update tasks set status = 'qa_pending', qa_attempts = n where id = tk.id;
    perform hq_log('qa-lead', 'qa.deferred', tk.request_id, tk.id, jsonb_build_object('attempts', n, 'reason', reason));
  end if;
  perform refresh_agent_status('qa-lead');
  perform refresh_agent_status(tk.agent_id);
  return case when n >= 3 then 'escalated' else 'retry' end;
end $$;

-- ---------- 3. planning claim + stale sweep ----------
create or replace function claim_request_for_planning() returns requests
language plpgsql security definer set search_path = public as $$
declare r requests;
begin
  perform hq_guard();
  select * into r from requests where status = 'staged' order by
    case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, created_at
  for update skip locked limit 1;
  if r.id is null then return null; end if;
  update requests set status = 'planning', planning_started_at = now() where id = r.id returning * into r;
  update agents set status = 'working', idle_activity = null where id = 'coo';
  return r;
end $$;

-- The worker's 60 s sweep. Returns how many things were recovered (tasks + reviews + plans).
create or replace function requeue_stale_tasks() returns int
language plpgsql security definer set search_path = public as $$
declare n_work int; n_qa int; n_plan int; a record;
begin
  perform hq_guard();
  with u as (
    update tasks set status = 'queued'
     where status = 'working' and coalesce(heartbeat_at, claimed_at, updated_at) < now() - interval '10 minutes'
    returning id, agent_id, request_id
  ), l as (
    insert into activity_log (actor, action, request_id, task_id, detail)
    select agent_id, 'task.requeued', request_id, id, '{"reason":"no heartbeat for 10 min"}'::jsonb from u
  )
  select count(*) into n_work from u;

  with u as (
    update tasks set status = 'qa_pending'
     where status = 'qa_reviewing' and coalesce(heartbeat_at, updated_at) < now() - interval '10 minutes'
    returning id, request_id
  ), l as (
    insert into activity_log (actor, action, request_id, task_id, detail)
    select 'qa-lead', 'qa.deferred', request_id, id, '{"reason":"review stalled for 10 min"}'::jsonb from u
  )
  select count(*) into n_qa from u;

  with u as (
    update requests set status = 'staged', planning_started_at = null
     where status = 'planning' and coalesce(planning_started_at, updated_at) < now() - interval '10 minutes'
    returning id
  ), l as (
    insert into activity_log (actor, action, request_id, detail)
    select 'coo', 'plan.deferred', id, '{"reason":"planning stalled for 10 min"}'::jsonb from u
  )
  select count(*) into n_plan from u;

  -- Nobody may look busy without work: COO without a request in planning, QA without a review, others without a task.
  for a in select ag.id from agents ag where ag.status = 'working' and (
      (ag.id = 'coo' and not exists (select 1 from requests where status = 'planning'))
   or (ag.id = 'qa-lead' and not exists (select 1 from tasks where status = 'qa_reviewing'))
   or (ag.id not in ('coo', 'qa-lead') and not exists (select 1 from tasks t where t.agent_id = ag.id and t.status in ('working', 'qa_reviewing'))))
  loop
    perform refresh_agent_status(a.id);
  end loop;
  for a in select ag.id from agents ag where ag.current_task_id is not null and ag.status <> 'working' loop
    perform refresh_agent_status(a.id);
  end loop;

  -- 2FA codes nobody picked up (the login tool gave up) never linger.
  for a in select ap.id from approvals ap
            where ap.kind = 'external_action' and ap.payload -> 'vault' ->> 'kind' = '2fa' and ap.status <> 'pending'
              and ap.ceo_note is not null and ap.ceo_note not like '[2FA %]' and ap.decided_at < now() - interval '10 minutes'
  loop
    perform vault_scrub_2fa(a.id, '[2FA code expired]');
  end loop;

  return n_work + n_qa + n_plan;
end $$;

-- ---------- 1 + 2 + 5. CEO decisions ----------
create or replace function decide_approval(p_approval uuid, p_decision text, p_note text default null, p_via text default 'dashboard')
returns text language plpgsql security definer set search_path = public as $$
declare ap approvals; t jsonb; keymap jsonb := '{}'; deps uuid[]; rq requests; tk tasks;
        new_status approval_status; result text; decision text := p_decision; note text := p_note;
        is2fa boolean; stored_note text; logged_note text; typ text; task_status text;
begin
  perform hq_guard();
  if decision not in ('approve', 'changes', 'reject') then raise exception 'bad decision %', decision; end if;

  select * into ap from approvals where id = p_approval for update;
  if ap.id is null then raise exception 'approval not found'; end if;
  if ap.status <> 'pending' then return 'already_' || ap.status; end if;
  typ := coalesce(ap.payload ->> 'type', '');

  -- Vault 2FA: an answer is the code. "changes" with text = approve with the code; approve needs the code.
  is2fa := vault_is_2fa(ap);
  if is2fa then
    if decision = 'changes' then decision := 'approve'; end if;
    note := nullif(regexp_replace(coalesce(note, ''), '\s+', '', 'g'), '');
    if decision = 'approve' and note is null then raise exception '2FA: reply with the one-time code'; end if;
  end if;
  if decision = 'changes' and coalesce(trim(note), '') = '' then raise exception 'say what should change'; end if;

  new_status := case decision when 'approve' then 'approved' when 'changes' then 'changes_requested' else 'rejected' end;
  stored_note := note;
  logged_note := note;
  if is2fa then
    select status::text into task_status from tasks where id = ap.task_id;
    -- Keep the code only while a login is actually waiting for it (the task is running); otherwise never store it.
    if decision <> 'approve' then stored_note := null;
    elsif ap.task_id is not null and coalesce(task_status, '') <> 'working' then stored_note := '[2FA code discarded]';
    end if;
    logged_note := case when decision = 'approve' then '[2FA code]' else null end;
  end if;
  update approvals set status = new_status, ceo_note = stored_note, decided_at = now(), decided_via = p_via where id = ap.id;

  if ap.kind = 'plan' then
    select * into rq from requests where id = ap.request_id for update;
    if decision = 'approve' then
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
    elsif decision = 'changes' then
      update requests set status = 'staged',
        brief = coalesce(brief, '{}') || jsonb_build_object('ceo_feedback', coalesce(brief -> 'ceo_feedback', '[]') || to_jsonb(note))
      where id = rq.id;
      result := 'replan';
    else
      update requests set status = 'rejected' where id = rq.id;
      result := 'plan_rejected';
    end if;

  elsif ap.kind = 'deliverable' then
    select * into tk from tasks where id = ap.task_id for update;
    if decision = 'approve' then
      update tasks set status = 'done', completed_at = now() where id = tk.id;
      perform release_ready_tasks(tk.request_id);
      result := 'task_done';
    elsif decision = 'changes' then
      update tasks set status = 'queued', revision_count = revision_count + 1,
        qa_feedback = jsonb_build_object('source', 'ceo', 'fix_list', jsonb_build_array(note))
      where id = tk.id;
      result := 'task_revision';
    else
      update tasks set status = 'cancelled' where id = tk.id;
      result := 'task_cancelled';
    end if;

  else -- external_action (incl. agent questions, failures and QA escalations)
    if ap.task_id is not null then
      select * into tk from tasks where id = ap.task_id for update;
      -- Only the approval that paused the task may resume it (a pending deliverable or another question is untouched).
      if tk.paused_by_approval = ap.id and tk.status in ('awaiting_ceo', 'failed') then
        if decision = 'reject' and typ in ('qa_escalation', 'task_failed', 'qa_stuck') then
          update tasks set status = 'cancelled', paused_by_approval = null where id = tk.id;
        elsif typ = 'qa_stuck' then
          update tasks set status = 'qa_pending', qa_attempts = 0, paused_by_approval = null where id = tk.id;
        else
          -- Resume the task with the CEO's answer; the worker executes approved actions itself.
          update tasks set status = 'queued', paused_by_approval = null,
            qa_feedback = coalesce(qa_feedback, '{}') || jsonb_build_object('ceo_decision', decision, 'ceo_note', note)
          where id = tk.id;
        end if;
      end if;
    end if;
    result := 'action_' || new_status;
  end if;

  -- Close the request when nothing is left open (after every kind of decision).
  perform close_request_if_finished(coalesce(tk.request_id, ap.request_id));

  if ap.agent_id is not null then perform refresh_agent_status(ap.agent_id); end if;
  if tk.agent_id is not null then perform refresh_agent_status(tk.agent_id); end if;
  perform hq_log('ceo', 'approval.' || new_status, ap.request_id, ap.task_id,
                 jsonb_build_object('approval_id', ap.id, 'kind', ap.kind, 'via', p_via, 'note', logged_note));
  return result;
end $$;

-- ---------- 5. vault 2FA handoff ----------
-- {status:'pending'} while waiting; {status:'approved', code} exactly once. Every other outcome returns its status
-- ('used' | 'no_code' | 'rejected' | 'expired' …) and scrubs whatever note is there.
create or replace function vault_take_2fa_code(p_approval uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ap approvals; code text;
begin
  perform vault_service_guard();
  select * into ap from approvals where id = p_approval and payload -> 'vault' ->> 'kind' = '2fa' for update;
  if ap.id is null then raise exception 'vault: not a 2FA request'; end if;
  if ap.status = 'pending' then return jsonb_build_object('status', 'pending'); end if;
  code := nullif(ap.ceo_note, '');
  if ap.status = 'approved' and code is not null and code not like '[2FA %]' then
    perform vault_scrub_2fa(ap.id, '[2FA code used]');
    if ap.agent_id is not null then perform refresh_agent_status(ap.agent_id); end if;
    return jsonb_build_object('status', 'approved', 'code', code);
  end if;
  perform vault_scrub_2fa(ap.id, '[2FA code discarded]');
  return jsonb_build_object('status', case
    when code = '[2FA code used]' then 'used'
    when code = '[2FA request expired]' then 'expired'
    when ap.status = 'approved' then 'no_code'
    else ap.status::text end);
end $$;

-- The login tool gave up waiting: close the question so a late answer is never stored, and scrub any code.
create or replace function vault_expire_2fa(p_approval uuid) returns void
language plpgsql security definer set search_path = public as $$
declare ap approvals;
begin
  perform vault_service_guard();
  select * into ap from approvals where id = p_approval and payload -> 'vault' ->> 'kind' = '2fa' for update;
  if ap.id is null then return; end if;
  if ap.status = 'pending' then
    update approvals set status = 'rejected', ceo_note = '[2FA request expired]', decided_at = now() where id = ap.id;
    if ap.agent_id is not null then perform refresh_agent_status(ap.agent_id); end if;
  else
    perform vault_scrub_2fa(ap.id, '[2FA code expired]');
  end if;
end $$;

-- ---------- 6. vault write allowlist ----------
create or replace function vault_write_allowlist_ok(p text[]) returns boolean language sql immutable as $$
  select coalesce(array_length(p, 1), 0) <= 25
     and not exists (select 1 from unnest(coalesce(p, '{}')) e where length(e) > 520 or e !~ '^(POST|PUT|PATCH) (/|https://)[^[:space:]]*$');
$$;

drop function if exists vault_insert_credential(uuid,uuid,text,text,text,text,text,bytea,bytea,int,text,text,text[],timestamptz,text,text[]);
create function vault_insert_credential(
  p_id uuid, p_client uuid, p_platform text, p_label text, p_login_url text, p_username text, p_secret_type text,
  p_cipher bytea, p_iv bytea, p_key_version int, p_twofa text default 'none', p_scope_notes text default null,
  p_url_allowlist text[] default '{}', p_expires_at timestamptz default null, p_created_by text default 'ceo',
  p_grants text[] default '{}', p_write_allowlist text[] default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare cl clients; g text;
begin
  perform vault_service_guard();
  select * into cl from clients where id = p_client;
  if cl.id is null then raise exception 'client not found'; end if;
  if cl.status = 'archived' then raise exception 'client is archived'; end if;
  if not vault_platform_ok(p_platform) then raise exception 'bad platform'; end if;
  if coalesce(trim(p_label), '') = '' then raise exception 'label is required'; end if;
  if p_cipher is null or p_iv is null then raise exception 'ciphertext is required'; end if;
  if not vault_write_allowlist_ok(p_write_allowlist) then raise exception 'bad write allowlist entry (use "PUT /path")'; end if;
  insert into client_credentials (id, client_id, platform, label, login_url, username, secret_type, secret_cipher, secret_iv,
                                  key_version, twofa_method, scope_notes, url_allowlist, expires_at, created_by, write_allowlist)
  values (coalesce(p_id, gen_random_uuid()), cl.id, p_platform, left(trim(p_label), 120), nullif(trim(p_login_url), ''),
          nullif(trim(p_username), ''), p_secret_type, p_cipher, p_iv, coalesce(p_key_version, 1), coalesce(p_twofa, 'none'),
          nullif(trim(p_scope_notes), ''), coalesce(p_url_allowlist, '{}'), p_expires_at, coalesce(p_created_by, 'ceo'),
          coalesce(p_write_allowlist, '{}'))
  returning id into p_id;
  foreach g in array coalesce(p_grants, '{}') loop
    insert into credential_grants (credential_id, agent_id)
    select p_id, a.id from agents a where a.id = g on conflict do nothing;
  end loop;
  perform vault_log_access(p_id, case when p_created_by = 'client_link' then 'client' else 'ceo' end, null, 'store', true,
                           jsonb_build_object('grants', coalesce(p_grants, '{}'), 'writes', coalesce(array_length(p_write_allowlist, 1), 0)));
  return p_id;
end $$;

-- p_write_allowlist null = keep the current list (e.g. "mark fixed" from the dashboard).
drop function if exists vault_update_credential(uuid,text,text,text,text,text,text[],timestamptz,text,text);
create function vault_update_credential(p_id uuid, p_label text, p_login_url text, p_username text,
  p_twofa text, p_scope_notes text, p_url_allowlist text[], p_expires_at timestamptz, p_platform text default null,
  p_status text default null, p_write_allowlist text[] default null)
returns void language plpgsql security definer set search_path = public as $$
declare c client_credentials;
begin
  perform hq_guard();
  select * into c from client_credentials where id = p_id for update;
  if c.id is null then raise exception 'credential not found'; end if;
  if coalesce(trim(p_label), '') = '' then raise exception 'label is required'; end if;
  if p_platform is not null and not vault_platform_ok(p_platform) then raise exception 'bad platform'; end if;
  if p_status is not null and p_status not in ('active', 'expiring') then raise exception 'use vault_revoke to revoke'; end if;
  if p_status is not null and c.status = 'revoked' then raise exception 'credential is revoked'; end if;
  if p_write_allowlist is not null and not vault_write_allowlist_ok(p_write_allowlist) then
    raise exception 'bad write allowlist entry (use "PUT /path")';
  end if;
  update client_credentials set label = left(trim(p_label), 120), login_url = nullif(trim(p_login_url), ''),
    username = nullif(trim(p_username), ''), twofa_method = coalesce(p_twofa, twofa_method),
    scope_notes = nullif(trim(p_scope_notes), ''), url_allowlist = coalesce(p_url_allowlist, '{}'), expires_at = p_expires_at,
    platform = coalesce(p_platform, platform), write_allowlist = coalesce(p_write_allowlist, write_allowlist),
    status = coalesce(p_status, status), failed_login_count = case when p_status = 'active' then 0 else failed_login_count end
  where id = p_id;
  perform vault_log_access(p_id, 'ceo', null, 'edit', true, '{}');
end $$;

create or replace function vault_list_for_agent(p_agent text, p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cl clients;
begin
  perform vault_service_guard();
  select * into cl from clients where id = p_client;
  if cl.id is null then raise exception 'client not found'; end if;
  return jsonb_build_object(
    'client', jsonb_build_object('id', cl.id, 'name', cl.name, 'slug', cl.slug, 'status', cl.status),
    'granted', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'platform', c.platform, 'label', c.label, 'login_url', c.login_url, 'username', c.username,
        'secret_type', c.secret_type, 'twofa_method', c.twofa_method, 'scope_notes', c.scope_notes,
        'url_allowlist', c.url_allowlist, 'write_allowlist', c.write_allowlist, 'status', c.status, 'expires_at', c.expires_at,
        'last_used_at', c.last_used_at)
        order by c.platform, c.label), '[]')
      from client_credentials c join credential_grants g on g.credential_id = c.id and g.agent_id = p_agent
      where c.client_id = cl.id and c.status <> 'revoked' and cl.status <> 'archived'),
    'not_granted', (select count(*) from client_credentials c where c.client_id = cl.id and c.status <> 'revoked'
      and not exists (select 1 from credential_grants g where g.credential_id = c.id and g.agent_id = p_agent)));
end $$;

drop function if exists vault_get_for_agent(uuid, text);
create function vault_get_for_agent(p_credential uuid, p_agent text)
returns table (id uuid, client_id uuid, platform text, label text, login_url text, username text, secret_type text,
               secret_cipher bytea, secret_iv bytea, key_version int, twofa_method text, scope_notes text,
               url_allowlist text[], status text, failed_login_count int, write_allowlist text[])
language plpgsql security definer set search_path = public as $$
declare c client_credentials; cl clients;
begin
  perform vault_service_guard();
  select * into c from client_credentials cc where cc.id = p_credential;
  if c.id is null then raise exception 'vault: credential not found'; end if;
  if not exists (select 1 from credential_grants g where g.credential_id = c.id and g.agent_id = p_agent) then
    raise exception 'vault: not granted';
  end if;
  select * into cl from clients where clients.id = c.client_id;
  if cl.status = 'archived' then raise exception 'vault: client archived'; end if;
  if c.status = 'revoked' then raise exception 'vault: revoked'; end if;
  if c.status = 'check_needed' then raise exception 'vault: check needed'; end if;
  if c.failed_login_count >= 2 then raise exception 'vault: check needed'; end if;
  return query select c.id, c.client_id, c.platform, c.label, c.login_url, c.username, c.secret_type, c.secret_cipher,
    c.secret_iv, c.key_version, c.twofa_method, c.scope_notes, c.url_allowlist, c.status, c.failed_login_count, c.write_allowlist;
end $$;

-- ---------- permissions ----------
do $$
declare f text;
begin
  -- 4. internal helpers: never reachable from a browser session (anon / authenticated).
  foreach f in array array['hq_log(text,text,uuid,uuid,jsonb)', 'refresh_agent_status(text)', 'finish_agent_turn(text)',
    'hq_guard()', 'hq_can_operate()', 'vault_scrub_2fa(uuid,text)', 'close_request_if_finished(uuid)', 'vault_is_2fa(approvals)',
    'vault_write_allowlist_ok(text[])', 'qa_review_failed(uuid,text)']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  -- CEO (dashboard) + worker
  foreach f in array array['decide_approval(uuid,text,text,text)', 'ask_ceo(uuid,text,jsonb)', 'fail_task(uuid,text)',
    'claim_qa_review()', 'record_qa_verdict(uuid,text,jsonb,int)', 'claim_request_for_planning()', 'requeue_stale_tasks()',
    'request_rizehub_action(uuid,text,jsonb,boolean)',
    'vault_update_credential(uuid,text,text,text,text,text,text[],timestamptz,text,text,text[])']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  -- worker only
  foreach f in array array['vault_take_2fa_code(uuid)', 'vault_expire_2fa(uuid)', 'vault_list_for_agent(text,uuid)',
    'vault_get_for_agent(uuid,text)',
    'vault_insert_credential(uuid,uuid,text,text,text,text,text,bytea,bytea,int,text,text,text[],timestamptz,text,text[],text[])']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
