-- RizeHub HQ · cost dashboard + design → dev handoff support
--
-- 1. ai_usage view: one row per model run (activity_log 'usage.*' rows written by record_usage()) with the
--    provider, model, tokens and cost pulled out of `detail`, plus the Asia/Manila day. This is what the dashboard
--    /costs page and ad-hoc SQL aggregate: spend per day, per agent (agent_id = actor), per client, per task and per
--    model. Per-task running totals stay on tasks.cost_usd / requests.cost_usd (record_usage keeps them up to date).
--    security_invoker: the caller's RLS on activity_log applies (only the CEO can read it; the worker uses service_role).
-- 2. Partial index for the worker's spend queries (today's / this month's usage.* rows).
--
-- Design → dev handoff needs no schema change: release_ready_tasks() (init schema) moves a 'pending' task to
-- 'queued' only when every depends_on task is 'done', and a task becomes 'done' only when the CEO approves its
-- deliverable after QA passed it (decide_approval). scripts/db-tests/100-costs-handoff.mjs checks this path.

-- ---------- 1. ai_usage ----------
create or replace view ai_usage with (security_invoker = true) as
select
  a.id,
  a.created_at,
  (a.created_at at time zone 'Asia/Manila')::date                        as usage_day,
  a.actor                                                                  as agent_id,
  substr(a.action, 7)                                                      as kind,        -- task | plan | qa | chat | report
  a.request_id,
  a.task_id,
  a.client_id,
  nullif(a.detail ->> 'provider', '')                                      as provider,
  nullif(a.detail ->> 'model', '')                                         as model,
  case when jsonb_typeof(a.detail -> 'tokens_in') = 'number' then (a.detail ->> 'tokens_in')::numeric::bigint else 0 end         as tokens_in,
  case when jsonb_typeof(a.detail -> 'tokens_out') = 'number' then (a.detail ->> 'tokens_out')::numeric::bigint else 0 end       as tokens_out,
  case when jsonb_typeof(a.detail -> 'cached_in') = 'number' then (a.detail ->> 'cached_in')::numeric::bigint else 0 end         as cached_in,
  case when jsonb_typeof(a.detail -> 'cache_write_in') = 'number' then (a.detail ->> 'cache_write_in')::numeric::bigint else 0 end as cache_write_in,
  a.cost_usd
from activity_log a
where a.action like 'usage.%';

comment on view ai_usage is 'One row per model run (activity_log usage.* rows): provider/model/tokens/cost by Manila day, agent, client and task. Read by the dashboard /costs page.';

revoke all on ai_usage from anon;
grant select on ai_usage to authenticated, service_role;

-- ---------- 2. spend queries ----------
create index if not exists activity_log_usage_created_at on activity_log (created_at) where action like 'usage.%';
