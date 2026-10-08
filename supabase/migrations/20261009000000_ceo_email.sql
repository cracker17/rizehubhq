-- "Email me updates" (docs/08 "Email", docs/15 §5c, docs/09 "Gmail"): the worker emails the CEO a copy of new results
-- (QA-passed deliverables), questions, plans and failures, FROM one connected Gmail account (its App Password) TO one
-- address the CEO sets. Approving still happens in HQ or Telegram: the emails carry no buttons that act.
--
-- 1. settings row 'ceo_email' = {enabled, connector_id, to, events {results, questions, failures, plans}, enabled_at},
--    written ONLY by ceo_email_set() (audited 'ceo_email.updated'). A new address, or turning it on, needs a fresh 2FA
--    code (ceo_step_up_guard): the address decides where every result goes. enabled_at is stamped when it is turned on
--    so nothing older is ever emailed (no backfill); turning it off clears it.
-- 2. ceo_email_log: one row per email (key 'approval:<id>' or 'test:<time>'), service role only. A failed send is
--    retried at most 3 times, 2 minutes apart. The CEO reads the last 20 through ceo_email_recent().
-- 3. ceo_email_pending(): what the worker should send now (service role only).

-- ---------- log ----------
create table ceo_email_log (
  key       text primary key check (char_length(key) <= 120),
  sent_at   timestamptz not null default now(),   -- last attempt
  ok        boolean not null,
  error     text check (char_length(error) <= 300),
  attempts  int not null default 1 check (attempts >= 1)
);
alter table ceo_email_log enable row level security;
-- No policy for authenticated/anon: only the service role (worker) touches it; the CEO reads via ceo_email_recent().
revoke all on ceo_email_log from authenticated, anon;

-- ---------- the settings row goes through the RPC only ----------
-- Same pattern as the ai_* rows (20260929070000_provider_keys.sql): the CEO keeps editing other settings rows directly
-- (RLS ceo_all), never 'ceo_email', so the 2FA rule and the audit row can't be skipped. The service role bypasses RLS.
create policy ceo_email_row_via_rpc_insert on settings as restrictive for insert to authenticated with check (key <> 'ceo_email');
create policy ceo_email_row_via_rpc_update on settings as restrictive for update to authenticated
  using (key <> 'ceo_email') with check (key <> 'ceo_email');
create policy ceo_email_row_via_rpc_delete on settings as restrictive for delete to authenticated using (key <> 'ceo_email');

-- Same rule as isEmailAddress() in packages/shared/src/ceoEmail.ts.
create or replace function ceo_email_address_ok(p text) returns boolean
language sql immutable set search_path = public as $$
  select p is not null and char_length(p) <= 254
     and p ~* '^[^[:space:]@<>(),;:"\\\[\]]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$';
$$;

-- Full replace of the CEO's email settings. p = {enabled: bool, connector_id: uuid|null, to: text|null,
-- events: {results, questions, failures, plans: bool}}. Returns the stored value.
create or replace function ceo_email_set(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  before jsonb := coalesce((select value from settings where key = 'ceo_email'), '{}'::jsonb);
  was_on boolean;
  on_ boolean;
  conn uuid;
  addr text;
  ev jsonb := coalesce(p -> 'events', '{}'::jsonb);
  k text;
  events jsonb := '{}'::jsonb;
  after jsonb;
begin
  perform hq_guard();
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'ceo_email_set: settings must be an object' using errcode = '22023'; end if;
  if jsonb_typeof(p -> 'enabled') is distinct from 'boolean' then raise exception 'ceo_email_set: enabled must be true or false' using errcode = '22023'; end if;
  on_ := (p ->> 'enabled')::boolean;
  was_on := jsonb_typeof(before -> 'enabled') = 'boolean' and (before ->> 'enabled')::boolean;

  -- recipient: one plain address, stored lower-case
  addr := nullif(lower(btrim(coalesce(p ->> 'to', ''))), '');
  if addr is not null and not ceo_email_address_ok(addr) then
    raise exception 'ceo_email_set: that is not a valid email address' using errcode = '22023';
  end if;

  -- sender: a Gmail connector (active whenever the emails are on)
  if nullif(btrim(coalesce(p ->> 'connector_id', '')), '') is not null then
    if (p ->> 'connector_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'ceo_email_set: unknown Gmail account' using errcode = '22023';
    end if;
    conn := (p ->> 'connector_id')::uuid;
    if not exists (select 1 from connectors c where c.id = conn and c.kind = 'gmail') then
      raise exception 'ceo_email_set: unknown Gmail account' using errcode = '22023';
    end if;
  end if;

  -- events: the four known switches (missing = default), nothing else
  if jsonb_typeof(ev) <> 'object' then raise exception 'ceo_email_set: events must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(ev) loop
    if k not in ('results', 'questions', 'failures', 'plans') then raise exception 'ceo_email_set: unknown event %', k using errcode = '22023'; end if;
    if jsonb_typeof(ev -> k) <> 'boolean' then raise exception 'ceo_email_set: event % must be true or false', k using errcode = '22023'; end if;
  end loop;
  events := jsonb_build_object(
    'results', coalesce((ev ->> 'results')::boolean, true), 'questions', coalesce((ev ->> 'questions')::boolean, true),
    'failures', coalesce((ev ->> 'failures')::boolean, true), 'plans', coalesce((ev ->> 'plans')::boolean, false));

  if on_ then
    if conn is null or not exists (select 1 from connectors c where c.id = conn and c.kind = 'gmail' and c.status = 'active') then
      raise exception 'ceo_email_set: pick an active Gmail account to send from' using errcode = '22023';
    end if;
    if addr is null then raise exception 'ceo_email_set: enter the address to send to' using errcode = '22023'; end if;
    if not exists (select 1 from jsonb_each(events) e where e.value = 'true'::jsonb) then
      raise exception 'ceo_email_set: pick at least one kind of update' using errcode = '22023';
    end if;
  end if;

  -- Where results go (a new address) and turning it on need a fresh 2FA code when the CEO has one.
  if (on_ and not was_on) or addr is distinct from nullif(lower(btrim(coalesce(before ->> 'to', ''))), '') then
    perform ceo_step_up_guard();
  end if;

  after := jsonb_build_object(
    'enabled', on_, 'connector_id', conn, 'to', addr, 'events', events,
    'enabled_at', case when on_ and was_on and jsonb_typeof(before -> 'enabled_at') = 'string' then before -> 'enabled_at'
                       when on_ then to_jsonb(now()) else 'null'::jsonb end);
  insert into settings (key, value) values ('ceo_email', after) on conflict (key) do update set value = excluded.value;
  if after is distinct from before then
    perform hq_log('ceo', 'ceo_email.updated', null, null, jsonb_build_object('before', before, 'after', after));
  end if;
  return after;
end $$;

-- What to email now: approvals created at/after p_since whose event is switched on, never sent, or failed fewer than
-- 3 times with the last try over 2 minutes ago. Action approvals (send / publish / app calls) and Vault 2FA questions are
-- never emailed: they stay in Telegram / the dashboard. Deliverable storage links: from the approval, else the task
-- (an auto-approved card is not updated when the files land).
create or replace function ceo_email_pending(p_since timestamptz, p_events text[], p_limit int default 50)
returns table (id uuid, event text, kind text, title text, summary text, payload jsonb, preview_url text, agent_id text,
               status text, decided_via text, created_at timestamptz, request_title text, request_text text,
               request_priority text, client_name text, task_storage jsonb, attempts int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform vault_service_guard();
  return query
  with ap as (
    select a.*, case
        when a.kind = 'deliverable' then 'results'
        when a.kind = 'plan' then 'plans'
        when a.kind = 'external_action' and coalesce(a.payload -> 'vault' ->> 'kind', '') = '2fa' then null
        when a.kind = 'external_action' and a.payload ->> 'type' = 'question' then 'questions'
        when a.kind = 'external_action' and a.payload ->> 'type' in ('task_failed', 'planning_failed', 'qa_escalation', 'qa_stuck') then 'failures'
      end as ev
    from approvals a
    where a.created_at >= p_since
  )
  select ap.id, ap.ev, ap.kind::text, ap.title, ap.summary, ap.payload, ap.preview_url, ap.agent_id, ap.status::text, ap.decided_via,
         ap.created_at, r.title, r.raw_text, r.priority, c.name, t.output -> 'storage', coalesce(l.attempts, 0)
  from ap
  left join requests r on r.id = ap.request_id
  left join clients c on c.id = r.client_id
  left join tasks t on t.id = ap.task_id
  left join ceo_email_log l on l.key = 'approval:' || ap.id::text
  where ap.ev is not null and ap.ev = any(coalesce(p_events, '{}'::text[]))
    and (l.key is null or (not l.ok and l.attempts < 3 and l.sent_at < now() - interval '2 minutes'))
  order by ap.created_at, ap.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

-- One attempt: first one inserts, later ones count up (a success after a failure keeps the count).
create or replace function ceo_email_record(p_key text, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform vault_service_guard();
  if p_key is null or p_key !~ '^(approval|test):[0-9A-Za-z:.+_-]{1,100}$' then
    raise exception 'ceo_email_record: bad key' using errcode = '22023';
  end if;
  insert into ceo_email_log (key, sent_at, ok, error, attempts)
  values (p_key, now(), coalesce(p_ok, false), case when p_ok then null else left(coalesce(p_error, 'unknown error'), 300) end, 1)
  on conflict (key) do update set sent_at = now(), ok = excluded.ok, error = excluded.error, attempts = ceo_email_log.attempts + 1;
end $$;

-- The CEO's view of the last 20 emails (Admin → Connectors → Email me updates).
create or replace function ceo_email_recent()
returns table (key text, title text, kind text, sent_at timestamptz, ok boolean, error text, attempts int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_ceo() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
  select l.key, case when l.key like 'test:%' then 'Test email' else coalesce(a.title, 'Removed item') end,
         case when l.key like 'test:%' then 'test' else a.kind::text end, l.sent_at, l.ok, l.error, l.attempts
  from ceo_email_log l
  left join approvals a on l.key like 'approval:%' and a.id::text = substr(l.key, 10)
  order by l.sent_at desc
  limit 20;
end $$;

do $$
declare f text;
begin
  foreach f in array array['ceo_email_set(jsonb)', 'ceo_email_recent()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array['ceo_email_pending(timestamptz, text[], int)', 'ceo_email_record(text, boolean, text)', 'ceo_email_address_ok(text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
