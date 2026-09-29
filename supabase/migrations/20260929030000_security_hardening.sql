-- RizeHub HQ · Security hardening (handoff open item 5): fixes the Supabase security-advisor WARNs on functions.
-- Docs: docs/03-DATABASE.md "Security hardening". Tests: scripts/db-tests/130-security-hardening.mjs.
--
-- Advisor state before this migration (production, 2026-09-29):
--   * function_search_path_mutable ............... 17 functions (all SECURITY INVOKER helpers)
--   * anon_security_definer_function_executable ... 6  (is_ceo, sales_client_slug, sales_is_suppressed,
--                                                      sales_lead_emails_guard, sales_on_approval_decided, sales_request_open)
--   * authenticated_security_definer_function_executable ... 59
--   * auth_leaked_password_protection ............. 1  (Auth setting, not SQL: Dashboard → Auth → Passwords)
--
-- Who calls what (grep of apps/dashboard, apps/bot, apps/worker for .rpc('name') / rpc('name') + SQL callers):
--   * dashboard server actions use the signed-in CEO's session (anon key + cookie → role authenticated),
--     never the service-role key (apps/dashboard/src/lib/supabase/server.ts).
--   * the Telegram bot and the worker use the service-role key (role service_role).
--   * the public client access-link page (/access) goes through the worker (vault_access_request_state /
--     vault_redeem_access_request are already service-role only), so the anon role needs NO function at all.
--   * every RLS policy in public is `to authenticated` and uses is_ceo() (checked with pg_policies), so is_ceo()
--     must stay executable by authenticated (Realtime evaluates the same policies as the subscriber) but not anon.
--   * SECURITY DEFINER functions run as their owner, so functions they call internally (triggers, helpers,
--     other definer functions) need no grant for the caller. Trigger functions are never checked for EXECUTE
--     when they fire, only at CREATE TRIGGER time.
--
-- Rules applied below:
--   A. CEO (dashboard) + service role ........ revoke public, anon  · grant authenticated, service_role
--   B. worker / bot only (service role) ...... revoke public, anon, authenticated · grant service_role
--   C. trigger functions ..................... revoke public, anon, authenticated · grant service_role
--   D. pure SECURITY INVOKER helpers ......... revoke public, anon  · grant authenticated, service_role
-- The authenticated_security_definer WARN stays, deliberately, for group A: those are the CEO's API, every one
-- starts with hq_guard() / is_ceo() (a signed-in non-CEO gets 'not allowed'), and the dashboard needs them.
-- If a dashboard screen later calls a group-B function, move it to group A in a NEW migration.

-- ---------- 1. fixed search_path for every public function that lacks one ----------
-- Deterministic: one pass over pg_proc in signature order; skips functions owned by an extension (pg_depend 'e')
-- and anything that already sets search_path. On production this is exactly the 17 advisor findings:
--   approval_is_high_risk(approvals), auto_approve_external_wording(), auto_approve_internal_work_types(),
--   claim_next_task(), hq_guard(), release_ready_tasks(uuid), rizehub_clean(text,int), sales_denied_host(text),
--   sales_detect_flags(text,text), sales_manila_day_start(timestamptz), sales_next_follow_up(timestamptz,int),
--   sales_suppression_permanent(), touch_updated_at(), vault_is_2fa(approvals), vault_platform_ok(text),
--   vault_service_guard(), vault_write_allowlist_ok(text[]).
-- None of them uses objects outside public/pg_catalog (auth.* calls are schema-qualified).
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')
    order by p.oid::regprocedure::text
  loop
    execute format('alter function %s set search_path = public', r.sig);
  end loop;
end $$;

-- ---------- 2. EXECUTE grants ----------
do $$
declare f text;
begin
  -- A. CEO (dashboard, role authenticated) + service role. Guarded inside by hq_guard()/is_ceo().
  foreach f in array array[
    'is_ceo()',                                     -- every RLS policy (to authenticated) + Realtime; anon never needs it
    'ceo_step_up_status()',                         -- the signed-in CEO's own {enrolled, fresh, aal} (docs/03 M12)
    'create_request(text,text,text,date,text)',     -- dashboard actions.ts (New Request)
    'decide_approval(uuid,text,text,text)',         -- dashboard actions.ts (approve/reject/changes); bot = service role
    'report_facts(date,int)',                       -- bot/worker digests; read-only numbers the CEO may see (suite 030)
    'create_access_request(uuid,text[],text,int,text)', -- dashboard vault-actions.ts (one-time client link)
    'vault_cancel_access_request(uuid)',            -- dashboard vault-actions.ts
    'vault_revoke(uuid,text)',                      -- dashboard vault-actions.ts
    'vault_set_grants(uuid,text[])',                -- dashboard vault-actions.ts
    'vault_grant(uuid,text)',                       -- CEO wrapper of vault_set_grants (suite 040)
    'vault_revoke_grant(uuid,text)',                -- CEO wrapper of vault_set_grants (suite 040)
    'vault_update_credential(uuid,text,text,text,text,text,text[],timestamptz,text,text,text[])', -- dashboard vault-actions.ts
    'connector_set_grants(uuid,text[])',            -- dashboard connector-actions.ts (step-up checked inside)
    'connector_update(uuid,text,jsonb)',            -- dashboard connector-actions.ts
    'connector_set_status(uuid,text)',              -- dashboard connector-actions.ts
    'connector_delete(uuid)',                       -- dashboard connector-actions.ts
    'save_auto_approve_rule(jsonb)',                -- dashboard security-actions.ts
    'delete_auto_approve_rule(uuid)',               -- dashboard security-actions.ts
    'mark_job_applied(uuid,int)',                   -- dashboard rizehub-actions.ts
    'set_job_status(uuid,text,timestamptz,text)',   -- dashboard rizehub-actions.ts (+ worker)
    'sales_move_stage(uuid,lead_stage,text,text)'   -- the CEO marks a lead won/lost (suite 090, actor 'ceo')
  ]
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;

  -- B. worker / bot only (service role). No dashboard caller; the CEO reaches these only through group A functions
  --    (which run as owner). Revoking authenticated removes them from /rest/v1/rpc for browser sessions.
  foreach f in array array[
    -- workflow engine (worker)
    'claim_request_for_planning()', 'release_request_for_planning(uuid,text)', 'submit_plan(uuid,jsonb)',
    'planning_failed(uuid,text)', 'claim_next_task()', 'release_ready_tasks(uuid)', 'claim_qa_review()',
    'release_qa_review(uuid,text)', 'record_qa_verdict(uuid,text,jsonb,int)', 'submit_task_output(uuid,jsonb)',
    'report_progress(uuid,int,text,jsonb)', 'touch_task_heartbeat(uuid)', 'requeue_task(uuid,text)',
    'requeue_stale_tasks()', 'fail_task(uuid,text)', 'ask_ceo(uuid,text,jsonb)',
    'request_external_action(uuid,text,jsonb)', 'external_action_exec(uuid,text,jsonb)',
    'record_usage(text,uuid,uuid,text,int,int,numeric,jsonb)', 'set_idle_activity(text,text)',
    'update_agent_screen(text,uuid,jsonb)',
    -- reports / Telegram (worker + bot)
    'save_report(text,date,text,jsonb,jsonb,jsonb,text,numeric,jsonb,boolean)',
    'set_paused(boolean,text)',                     -- bot /pause; the dashboard has no pause control today
    -- RizeHub integration (worker)
    'store_webhook_event(text,text,jsonb,boolean)', 'process_rizehub_event(uuid)', 'rizehub_open_request(text)',
    'record_rizehub_ref(uuid,text,text,jsonb,uuid)', 'request_rizehub_action(uuid,text,jsonb,boolean)',
    'rizehub_job_finished(text,text,jsonb)', 'park_task_for_job(uuid,text,jsonb)',
    'upsert_job_opportunity(jsonb,uuid)', 'queue_job_follow_ups()',
    -- sales pipeline (worker; internal helpers called only from definer functions / triggers)
    'sales_create_daily_batch(date,boolean,int)', 'sales_decide_batch(uuid,jsonb,text,text,text)',
    'sales_suppress(text,text,text,uuid)', 'sales_client_slug(text)', 'sales_is_suppressed(text)',
    'sales_request_open(uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- C. trigger functions: only ever run by their triggers (no EXECUTE check at fire time).
  foreach f in array array[
    'touch_updated_at()', 'sales_suppression_permanent()', 'sales_lead_emails_guard()', 'sales_on_approval_decided()'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- D. pure SECURITY INVOKER helpers that still had PUBLIC (hence anon) EXECUTE. Some sit in CHECK constraints
  --    (sales_denied_host on leads) that are evaluated as the writing role, so authenticated keeps them.
  foreach f in array array[
    'rizehub_clean(text,int)', 'sales_denied_host(text)', 'sales_detect_flags(text,text)',
    'sales_manila_day_start(timestamptz)', 'sales_next_follow_up(timestamptz,int)', 'vault_platform_ok(text)'
  ]
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
