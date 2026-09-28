-- RizeHub HQ · M12: CEO TOTP 2FA (step-up for high-risk actions) + auto-approve rules for low-risk plans.
-- Specs: docs/09-SECURITY-CONNECTIONS.md "Dashboard security", docs/05-ORCHESTRATION.md "[3] Auto-approve rules",
--        docs/03-DATABASE.md "M12 · TOTP + auto-approve". Tests: scripts/db-tests/110-totp-auto-approve.mjs.
--
-- 2FA uses Supabase Auth MFA (TOTP). The dashboard enrolls/verifies factors with supabase-js; the database only reads
-- the result from the session JWT (aal, amr) and from auth.mfa_factors:
--   * is_ceo() requires an aal2 session once the CEO has a verified TOTP factor (RLS everywhere follows).
--   * Approving a HIGH-RISK approval needs a fresh TOTP step-up (TOTP verified in the last 5 minutes, amr claim).
--     High-risk = kind 'external_action' with payload.type 'external_action': an agent/tool/sales proposal that
--     changes the outside world (publish, send, merge, deploy, spend, RizeHub actions, outreach emails). Questions,
--     failures, QA escalations and Vault 2FA relays are not high-risk. Rejecting or requesting changes never needs it.
--   * The Telegram bot (service role) cannot step up, so once 2FA is on it can no longer APPROVE high-risk actions
--     (reject / request changes still work there). Direct DB sessions (SQL editor, migrations) are not checked.
-- Recovery (lost phone): delete the factor with the service role, see docs/09 "Two-factor (TOTP)".
--
-- Auto-approve: plan_auto_approve_rules (CEO-edited, default none) are applied by submit_plan() itself, so the plan
-- approval is decided server-side in the same transaction with decided_via = 'auto', payload.auto_approved = {rule}
-- and an activity 'plan.auto_approved' naming the rule. Only kind = 'plan' can ever be auto-approved; external
-- actions (publish/send/merge/deploy/spend) always wait for the CEO.

-- ---------- approvals: 'auto' decisions; no direct writes from the browser ----------
alter table approvals drop constraint if exists approvals_decided_via_check;
alter table approvals add constraint approvals_decided_via_check check (decided_via in ('dashboard', 'telegram', 'auto'));
-- Every decision goes through decide_approval() (step-up, audit). The bot/worker (service role) keep their access.
revoke insert, update, delete on approvals from authenticated, anon;

-- The old boolean switch is superseded by the rules table (no rules = everything asks).
delete from settings where key = 'auto_approve_plans';

-- ---------- TOTP helpers ----------
-- Verified TOTP factor for this user (or for any CEO when p_user is null). False where auth.mfa_factors doesn't exist.
create or replace function ceo_totp_enrolled(p_user uuid default null) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if to_regclass('auth.mfa_factors') is null then return false; end if;
  return exists (
    select 1 from auth.mfa_factors f join ceo_users c on c.user_id = f.user_id
     where f.status::text = 'verified' and f.factor_type::text = 'totp' and (p_user is null or f.user_id = p_user));
end $$;

-- The current session verified a TOTP code in the last p_max_age seconds (JWT amr entry, aal2 session).
create or replace function ceo_totp_fresh(p_max_age int default 300) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare claims jsonb := auth.jwt(); e jsonb; ts numeric;
begin
  if coalesce(claims ->> 'aal', '') <> 'aal2' or jsonb_typeof(claims -> 'amr') is distinct from 'array' then return false; end if;
  for e in select * from jsonb_array_elements(claims -> 'amr') loop
    continue when jsonb_typeof(e) <> 'object' or coalesce(e ->> 'method', '') not in ('totp', 'mfa/totp');
    continue when coalesce(e ->> 'timestamp', '') !~ '^\d+(\.\d+)?$';
    ts := (e ->> 'timestamp')::numeric;
    if ts >= extract(epoch from now()) - p_max_age and ts <= extract(epoch from now()) + 60 then return true; end if;
  end loop;
  return false;
end $$;

-- Raises unless the caller may do a step-up-protected action right now:
--   direct DB session (no JWT) → ok · CEO without TOTP → ok (nothing to step up with; the dashboard asks to enroll)
--   CEO with TOTP → needs ceo_totp_fresh() · anyone else (service role = Telegram bot) → refused once the CEO has TOTP.
create or replace function ceo_step_up_guard() returns void
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); role text := coalesce(nullif(auth.jwt() ->> 'role', ''), nullif(current_setting('request.jwt.claim.role', true), ''), '');
begin
  if uid is null and role = '' then return; end if;
  if uid is not null and exists (select 1 from ceo_users where user_id = uid) then
    if not ceo_totp_enrolled(uid) or ceo_totp_fresh(300) then return; end if;
  elsif not ceo_totp_enrolled(null) then
    return;
  end if;
  raise exception 'step_up_required: confirm with a fresh 2FA code in the dashboard';
end $$;

-- Only the CEO; once they have TOTP, only from a session that passed it (aal2).
create or replace function is_ceo() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null or not exists (select 1 from ceo_users where user_id = uid) then return false; end if;
  if ceo_totp_enrolled(uid) and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then return false; end if;
  return true;
end $$;

-- High-risk approval (see header). Mirrored by approvalRisk() in apps/dashboard/src/lib/auth/stepUp.ts.
create or replace function approval_is_high_risk(p approvals) returns boolean
language sql immutable as $$
  select p.kind = 'external_action'
     and coalesce(p.payload ->> 'type', '') = 'external_action'
     and coalesce(p.payload -> 'vault' ->> 'kind', '') <> '2fa';
$$;

-- For the dashboard: may this session approve high-risk actions without entering a code now?
create or replace function ceo_step_up_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_ceo() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('enrolled', ceo_totp_enrolled(auth.uid()), 'fresh', ceo_totp_fresh(300), 'aal', auth.jwt() ->> 'aal');
end $$;

-- ---------- auto-approve rules ----------
create or replace function auto_approve_internal_work_types() returns text[] language sql immutable as $$
  select array['seo-article', 'landing-copy', 'meta-tags', 'keyword-research', 'content-calendar', 'social-captions', 'short-video-script',
               'wireframe', 'ui-mockup', 'ux-audit', 'ad-creative', 'social-graphic', 'brand-asset',
               'lead-report', 'lead-qualification', 'dm-reply-draft', 'job-search', 'job-application',
               'weekly-summary', 'daily-report', 'inbox-triage', 'meeting-prep']::text[];
$$;

-- Same words as EXTERNAL_WORDING in packages/shared/src/autoApprove.ts (whole words, case-insensitive).
create or replace function auto_approve_external_wording() returns text language sql immutable as $$
  select 'publish\w*|deploy\w*|merg(e|es|ed|ing)|send\w*|sent|go live|goes live|going live|spend\w*|purchas\w*|buy|buys|buying|bought|pay|pays|paid|payment\w*|invoic\w*|refund\w*|delet\w*|email(s|ed|ing)? (it |them )?to|post(s|ed|ing)? (it |them )?(on|to)'::text;
$$;

create table if not exists plan_auto_approve_rules (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) between 1 and 80),
  enabled       boolean not null default true,
  max_cost_usd  numeric(10,2) not null check (max_cost_usd >= 0 and max_cost_usd <= 100),
  max_tasks     int check (max_tasks between 1 and 20),
  work_types    text[] not null default '{}' check (work_types <@ auto_approve_internal_work_types()),  -- {} = any internal
  client_scope  text not null default 'any' check (client_scope in ('any', 'none', 'listed')),
  client_slugs  text[] not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (client_scope <> 'listed' or cardinality(client_slugs) > 0)
);
create trigger t_plan_auto_approve_rules_touch before update on plan_auto_approve_rules for each row execute function touch_updated_at();
alter table plan_auto_approve_rules enable row level security;
create policy ceo_all on plan_auto_approve_rules for all to authenticated using (is_ceo()) with check (is_ceo());
-- The CEO reads rules directly; changes go through save/delete_auto_approve_rule (validation, step-up, audit).
revoke insert, update, delete on plan_auto_approve_rules from authenticated, anon;

-- Hard guards no rule can override. Null = rules may be considered; otherwise the reason (mirrors planAutoApproveBlocker).
create or replace function plan_auto_approve_blocker(p_plan jsonb) returns text
language plpgsql stable set search_path = public as $$
declare t jsonb; re text := '\y(' || auto_approve_external_wording() || ')\y'; w text; c text;
begin
  if jsonb_typeof(p_plan -> 'tasks') is distinct from 'array' or jsonb_array_length(p_plan -> 'tasks') = 0 then return 'the plan has no tasks'; end if;
  if jsonb_typeof(p_plan -> 'questions_for_ceo') = 'array' and jsonb_array_length(p_plan -> 'questions_for_ceo') > 0 then
    return 'the plan has questions for the CEO';
  end if;
  if jsonb_typeof(p_plan -> 'estimated_cost_usd') is distinct from 'number' then return 'the plan has no cost estimate'; end if;
  for t in select * from jsonb_array_elements(p_plan -> 'tasks') loop
    if not coalesce(t ->> 'work_type', '') = any(auto_approve_internal_work_types()) then
      return format('task %s (%s) is not internal-only work', coalesce(t ->> 'key', '?'), coalesce(t ->> 'work_type', 'no work type'));
    end if;
  end loop;
  w := coalesce(substring(coalesce(p_plan ->> 'title', '') from '(?i)' || re), substring(coalesce(p_plan ->> 'summary', '') from '(?i)' || re));
  if w is not null then return format('the plan mentions "%s" (an external action)', w); end if;
  for t in select * from jsonb_array_elements(p_plan -> 'tasks') loop
    w := coalesce(substring(coalesce(t ->> 'title', '') from '(?i)' || re), substring(coalesce(t ->> 'instructions', '') from '(?i)' || re));
    if w is null and jsonb_typeof(t -> 'acceptance_criteria') = 'array' then
      for c in select jsonb_array_elements_text(t -> 'acceptance_criteria') loop
        w := substring(c from '(?i)' || re);
        exit when w is not null;
      end loop;
    end if;
    if w is not null then return format('task %s mentions "%s" (an external action)', coalesce(t ->> 'key', '?'), w); end if;
  end loop;
  return null;
end $$;

-- Why the rule doesn't cover the plan (null = it does). Mirrors ruleMiss().
create or replace function plan_auto_approve_rule_miss(p_plan jsonb, p_client_slug text, r plan_auto_approve_rules) returns text
language plpgsql stable set search_path = public as $$
declare n int := jsonb_array_length(p_plan -> 'tasks'); cost numeric := (p_plan ->> 'estimated_cost_usd')::numeric; wt text;
begin
  if not r.enabled then return 'rule is off'; end if;
  if cost > r.max_cost_usd then return format('estimated $%s is over $%s', cost, r.max_cost_usd); end if;
  if r.max_tasks is not null and n > r.max_tasks then return format('%s tasks is over %s', n, r.max_tasks); end if;
  if cardinality(r.work_types) > 0 then
    select x ->> 'work_type' into wt from jsonb_array_elements(p_plan -> 'tasks') x
     where not coalesce(x ->> 'work_type', '') = any(r.work_types) limit 1;
    if found then return format('work type %s is not in the rule', wt); end if;
  end if;
  if r.client_scope = 'none' and p_client_slug is not null then return 'rule is for internal requests only'; end if;
  if r.client_scope = 'listed' and (p_client_slug is null or not p_client_slug = any(r.client_slugs)) then return 'client is not in the rule'; end if;
  return null;
end $$;

-- Applies the rules to a pending PLAN approval. Returns {rule_id, rule_name} when it approved it, else null.
-- Never touches any other kind: external actions (publish/send/merge/deploy/spend) always wait for the CEO.
create or replace function auto_approve_plan(p_approval uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ap approvals; slug text; r plan_auto_approve_rules; blocker text; res text;
begin
  perform hq_guard();
  select * into ap from approvals where id = p_approval;
  if ap.id is null or ap.kind <> 'plan' or ap.status <> 'pending' then return null; end if;
  if not exists (select 1 from plan_auto_approve_rules where enabled) then return null; end if;

  blocker := plan_auto_approve_blocker(ap.payload);
  if blocker is not null then
    perform hq_log('system', 'plan.auto_approve_skipped', ap.request_id, null, jsonb_build_object('approval_id', ap.id, 'reason', blocker));
    return null;
  end if;
  select c.slug into slug from requests rq join clients c on c.id = rq.client_id where rq.id = ap.request_id;

  for r in select * from plan_auto_approve_rules where enabled order by created_at, id loop
    continue when plan_auto_approve_rule_miss(ap.payload, slug, r) is not null;
    update approvals set payload = payload || jsonb_build_object('auto_approved',
      jsonb_build_object('rule_id', r.id, 'rule_name', r.name, 'max_cost_usd', r.max_cost_usd, 'at', now()))
     where id = ap.id;
    perform set_config('hq.auto_approving', ap.id::text, true);
    res := decide_approval(ap.id, 'approve', 'Auto-approved by rule "' || r.name || '"', 'auto');
    perform set_config('hq.auto_approving', '', true);
    perform hq_log('system', 'plan.auto_approved', ap.request_id, null,
      jsonb_build_object('approval_id', ap.id, 'rule_id', r.id, 'rule_name', r.name, 'result', res,
                         'estimated_cost_usd', ap.payload -> 'estimated_cost_usd', 'client_slug', slug));
    return jsonb_build_object('rule_id', r.id, 'rule_name', r.name);
  end loop;
  return null;
end $$;

-- CEO: create (no id) or update a rule. p_rule = {id?, name, enabled, max_cost_usd, max_tasks, work_types, client_scope,
-- client_slugs}. Turning a rule ON (or saving an enabled one) loosens the approval gate → needs a fresh 2FA step-up.
create or replace function save_auto_approve_rule(p_rule jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid := nullif(p_rule ->> 'id', '')::uuid; en boolean := coalesce((p_rule ->> 'enabled')::boolean, true);
        wts text[]; slugs text[]; scope text := coalesce(p_rule ->> 'client_scope', 'any'); bad text;
begin
  perform hq_guard();
  if en then perform ceo_step_up_guard(); end if;
  select coalesce(array_agg(distinct x), '{}') into wts from jsonb_array_elements_text(coalesce(p_rule -> 'work_types', '[]')) x;
  select coalesce(array_agg(distinct x), '{}') into slugs from jsonb_array_elements_text(coalesce(p_rule -> 'client_slugs', '[]')) x;
  select x into bad from unnest(wts) x where not x = any(auto_approve_internal_work_types()) limit 1;
  if bad is not null then raise exception 'work type % is not internal-only work and can never be auto-approved', bad; end if;
  if scope <> 'listed' then slugs := '{}'; end if;
  select x into bad from unnest(slugs) x where not exists (select 1 from clients c where c.slug = x) limit 1;
  if bad is not null then raise exception 'unknown client %', bad; end if;

  if rid is null then
    insert into plan_auto_approve_rules (name, enabled, max_cost_usd, max_tasks, work_types, client_scope, client_slugs)
    values (trim(p_rule ->> 'name'), en, (p_rule ->> 'max_cost_usd')::numeric, nullif(p_rule ->> 'max_tasks', '')::int, wts, scope, slugs)
    returning id into rid;
  else
    update plan_auto_approve_rules set name = trim(p_rule ->> 'name'), enabled = en, max_cost_usd = (p_rule ->> 'max_cost_usd')::numeric,
      max_tasks = nullif(p_rule ->> 'max_tasks', '')::int, work_types = wts, client_scope = scope, client_slugs = slugs
     where id = rid;
    if not found then raise exception 'rule not found'; end if;
  end if;
  perform hq_log('ceo', 'auto_approve.rule_saved', null, null,
    (select jsonb_build_object('rule_id', r.id, 'name', r.name, 'enabled', r.enabled, 'max_cost_usd', r.max_cost_usd, 'max_tasks', r.max_tasks,
                               'work_types', r.work_types, 'client_scope', r.client_scope, 'client_slugs', r.client_slugs)
       from plan_auto_approve_rules r where r.id = rid));
  return rid;
end $$;

-- CEO: delete a rule (makes the gate stricter: no step-up).
create or replace function delete_auto_approve_rule(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r plan_auto_approve_rules;
begin
  perform hq_guard();
  delete from plan_auto_approve_rules where id = p_id returning * into r;
  if r.id is null then raise exception 'rule not found'; end if;
  perform hq_log('ceo', 'auto_approve.rule_deleted', null, null, jsonb_build_object('rule_id', r.id, 'name', r.name));
end $$;

-- ---------- 2. COO plan (was 20260928010000): now applies the auto-approve rules ----------
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
  perform auto_approve_plan(aid);   -- CEO rules; no rules (default) = the plan waits for the CEO
  return aid;
end $$;

-- ---------- 3. CEO decisions (was 20260928070000) + step-up for high-risk approvals + 'auto' for plans ----------
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

  -- 'auto' only from auto_approve_plan() for this very plan approval: never an external action, never a person.
  if p_via = 'auto' and (ap.kind <> 'plan' or decision <> 'approve'
                         or coalesce(current_setting('hq.auto_approving', true), '') <> ap.id::text) then
    raise exception 'auto-approval is only for plans, by an auto-approve rule';
  end if;

  -- Vault 2FA: an answer is the code. "changes" with text = approve with the code; approve needs the code.
  is2fa := vault_is_2fa(ap);
  if is2fa then
    if decision = 'changes' then decision := 'approve'; end if;
    note := nullif(regexp_replace(coalesce(note, ''), '\s+', '', 'g'), '');
    if decision = 'approve' and note is null then raise exception '2FA: reply with the one-time code'; end if;
  end if;
  if decision = 'changes' and coalesce(trim(note), '') = '' then raise exception 'say what should change'; end if;

  -- High-risk external actions: approving needs a fresh TOTP step-up (see header).
  if decision = 'approve' and approval_is_high_risk(ap) then perform ceo_step_up_guard(); end if;

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
  perform hq_log(case when p_via = 'auto' then 'system' else 'ceo' end, 'approval.' || new_status, ap.request_id, ap.task_id,
                 jsonb_build_object('approval_id', ap.id, 'kind', ap.kind, 'via', p_via, 'note', logged_note));
  return result;
end $$;

-- ---------- permissions ----------
do $$
declare f text;
begin
  -- internal helpers: never reachable from a browser session
  foreach f in array array['ceo_totp_enrolled(uuid)', 'ceo_totp_fresh(int)', 'ceo_step_up_guard()', 'auto_approve_plan(uuid)',
    'plan_auto_approve_blocker(jsonb)', 'plan_auto_approve_rule_miss(jsonb,text,plan_auto_approve_rules)']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  -- CEO (dashboard) + worker
  foreach f in array array['decide_approval(uuid,text,text,text)', 'submit_plan(uuid,jsonb)', 'save_auto_approve_rule(jsonb)',
    'delete_auto_approve_rule(uuid)', 'ceo_step_up_status()']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  -- pure helpers (constants, classification)
  foreach f in array array['auto_approve_internal_work_types()', 'auto_approve_external_wording()', 'approval_is_high_risk(approvals)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
