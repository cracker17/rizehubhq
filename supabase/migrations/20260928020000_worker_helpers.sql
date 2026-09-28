-- RizeHub HQ · worker helpers (M5/M6). Small state transitions the AI worker needs on top of
-- 20260928010000_workflow_engine.sql. Same rules: hq_guard(), security definer, service role / CEO only.

-- COO could not produce a valid plan: request → failed, CEO gets an external_action approval.
create or replace function planning_failed(p_request uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare rq requests; aid uuid; reason text := coalesce(nullif(trim(p_reason), ''), 'unknown error');
begin
  perform hq_guard();
  update requests set status = 'failed' where id = p_request and status in ('planning', 'staged') returning * into rq;
  if rq.id is null then raise exception 'request % is not being planned', p_request; end if;
  insert into approvals (kind, request_id, agent_id, title, summary, payload)
  values ('external_action', rq.id, 'coo', left('COO couldn''t plan this: ' || reason, 200), reason,
          jsonb_build_object('type', 'planning_failed', 'reason', reason, 'raw_text', rq.raw_text,
                             'options', jsonb_build_array('rephrase', 'cancel')))
  returning id into aid;
  -- The COO's turn is over; its status is recomputed (pending approval → waiting).
  perform refresh_agent_status('coo');
  perform hq_log('coo', 'plan.failed', rq.id, null, jsonb_build_object('reason', reason));
  return aid;
end $$;

-- Planning could not start (e.g. no model quota): hand the request back to the queue untouched.
create or replace function release_request_for_planning(p_request uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  update requests set status = 'staged' where id = p_request and status = 'planning';
  perform refresh_agent_status('coo');
  perform hq_log('coo', 'plan.deferred', p_request, null, jsonb_build_object('reason', p_reason));
end $$;

-- Heartbeat without touching the POV screen.
create or replace function touch_task_heartbeat(p_task uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  update tasks set heartbeat_at = now() where id = p_task and status in ('working', 'qa_reviewing');
end $$;

-- Quota hit / worker shutdown: put a working task back in the queue without counting it as a failure.
create or replace function requeue_task(p_task uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare tk tasks;
begin
  perform hq_guard();
  update tasks set status = 'queued' where id = p_task and status = 'working' returning * into tk;
  if tk.id is null then return; end if;
  perform refresh_agent_status(tk.agent_id);
  perform hq_log(tk.agent_id, 'task.requeued', tk.request_id, tk.id, jsonb_build_object('reason', p_reason));
end $$;

-- QA could not run (quota, no valid verdict): hand the review back without a verdict.
create or replace function release_qa_review(p_task uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare tk tasks;
begin
  perform hq_guard();
  update tasks set status = 'qa_pending' where id = p_task and status = 'qa_reviewing' returning * into tk;
  perform refresh_agent_status('qa-lead');
  if tk.id is not null then
    perform hq_log('qa-lead', 'qa.deferred', tk.request_id, tk.id, jsonb_build_object('reason', p_reason));
  end if;
end $$;

-- An agent proposes an external action (publish/send/merge/deploy/spend). Nothing executes until the CEO
-- approves; the worker then runs fixed code with exactly this payload. The task itself keeps running.
create or replace function request_external_action(p_task uuid, p_type text, p_spec jsonb default '{}') returns uuid
language plpgsql security definer set search_path = public as $$
declare tk tasks; aid uuid; descr text;
begin
  perform hq_guard();
  if coalesce(trim(p_type), '') = '' then raise exception 'action type is required'; end if;
  select * into tk from tasks where id = p_task;
  if tk.id is null then raise exception 'task not found'; end if;
  descr := coalesce(p_spec ->> 'description', p_type);
  insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
  values ('external_action', tk.request_id, tk.id, tk.agent_id, left('Action: ' || p_type || ' — ' || descr, 200), descr,
          jsonb_build_object('type', 'external_action', 'action_type', p_type, 'spec', coalesce(p_spec, '{}')))
  returning id into aid;
  perform hq_log(tk.agent_id, 'action.requested', tk.request_id, tk.id, jsonb_build_object('approval_id', aid, 'action_type', p_type));
  return aid;
end $$;

-- Usage meter (docs/14): one activity_log row per model run + running totals on the task and request.
create or replace function record_usage(p_actor text, p_task uuid, p_request uuid, p_kind text,
                                        p_tokens_in int, p_tokens_out int, p_cost numeric, p_detail jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare rid uuid := p_request; cid uuid;
begin
  perform hq_guard();
  if p_task is not null then
    update tasks set tokens_in = tokens_in + coalesce(p_tokens_in, 0), tokens_out = tokens_out + coalesce(p_tokens_out, 0),
                     cost_usd = cost_usd + coalesce(p_cost, 0)
     where id = p_task returning request_id, client_id into rid, cid;
  end if;
  if rid is not null then
    update requests set cost_usd = cost_usd + coalesce(p_cost, 0) where id = rid returning coalesce(cid, client_id) into cid;
  end if;
  insert into activity_log (actor, action, request_id, task_id, client_id, detail, cost_usd)
  values (p_actor, 'usage.' || coalesce(p_kind, 'run'), rid, p_task, cid,
          coalesce(p_detail, '{}') || jsonb_build_object('tokens_in', coalesce(p_tokens_in, 0), 'tokens_out', coalesce(p_tokens_out, 0)),
          coalesce(p_cost, 0));
end $$;

-- Idle shuffler (docs/07 §5): only idle agents change activity, so a just-claimed agent never walks off.
create or replace function set_idle_activity(p_agent text, p_activity text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  update agents set idle_activity = p_activity where id = p_agent and status = 'idle' and enabled;
  return found;
end $$;

-- POV screen for agents that are not the task owner (COO planning, QA reviewing).
create or replace function update_agent_screen(p_agent text, p_task uuid, p_screen jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  insert into agent_screens (agent_id, task_id, app, title, content, image_url, step_note, progress, updated_at)
  values (p_agent, p_task, coalesce(p_screen ->> 'app', 'doc'), p_screen ->> 'title', left(p_screen ->> 'content', 4000),
          p_screen ->> 'image_url', p_screen ->> 'step_note', greatest(0, least(100, coalesce((p_screen ->> 'progress')::int, 0))), now())
  on conflict (agent_id) do update set task_id = excluded.task_id, app = excluded.app, title = excluded.title,
    content = excluded.content, image_url = excluded.image_url, step_note = excluded.step_note,
    progress = excluded.progress, updated_at = now();
end $$;

do $$
declare f text;
begin
  foreach f in array array['planning_failed(uuid,text)','release_request_for_planning(uuid,text)','touch_task_heartbeat(uuid)',
    'requeue_task(uuid,text)','release_qa_review(uuid,text)','request_external_action(uuid,text,jsonb)',
    'record_usage(text,uuid,uuid,text,int,int,numeric,jsonb)','set_idle_activity(text,text)','update_agent_screen(text,uuid,jsonb)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
