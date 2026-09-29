-- M13.2 MCP connectors (docs/15 §3–4): the tools each connected MCP server offers and what agents may do with each:
-- allow (agent calls it), ask (every call is a CEO approval), off (hidden). Connections themselves live in `connectors`
-- (kind 'mcp', 20260929020000_connectors.sql); tokens are sealed there by the worker.

create table connector_tools (
  connector_id  uuid not null references connectors(id) on delete cascade,
  name          text not null,
  description   text not null default '',
  input_schema  jsonb not null default '{}',
  annotations   jsonb not null default '{}',
  policy        text not null default 'ask' check (policy in ('allow', 'ask', 'off')),
  locked_reason text check (locked_reason in ('money', 'contact')),
  badges        text[] not null default '{}',
  review_needed boolean not null default false,  -- new or changed after connecting: arrives Off until the CEO looks
  updated_at    timestamptz not null default now(),
  primary key (connector_id, name),
  check (not (locked_reason is not null and policy = 'allow'))
);

alter table connector_tools enable row level security;
create policy ceo_all on connector_tools for all to authenticated using (is_ceo()) with check (is_ceo());
revoke insert, update, delete on connector_tools from authenticated, anon;
alter publication supabase_realtime add table connector_tools;

create or replace function connector_policy_rank(p text) returns int
language sql immutable set search_path = public as $$
  select case p when 'allow' then 2 when 'ask' then 1 else 0 end;
$$;

-- ---------- worker only ----------
-- Replaces the stored tool list with what the server lists now. p_tools: [{name, description, input_schema, annotations,
-- policy, locked, badges}] with the worker's default policy (packages/shared defaultToolPolicy). On the first sync
-- (p_initial) the defaults apply; afterwards a NEW tool or a CHANGED description/schema arrives 'off' + review_needed,
-- existing policies are kept, and tools the server no longer lists are removed.
create or replace function connector_tools_sync(p_id uuid, p_tools jsonb, p_initial boolean)
returns int language plpgsql security definer set search_path = public as $$
declare t jsonb; cur connector_tools; n int := 0; lk text;
begin
  perform vault_service_guard();
  if not exists (select 1 from connectors where id = p_id and kind = 'mcp') then
    raise exception 'connector_tools_sync: unknown MCP connector' using errcode = 'P0002';
  end if;
  delete from connector_tools where connector_id = p_id
    and name not in (select x ->> 'name' from jsonb_array_elements(coalesce(p_tools, '[]')) x);
  for t in select * from jsonb_array_elements(coalesce(p_tools, '[]')) loop
    lk := nullif(t ->> 'locked', '');
    select * into cur from connector_tools where connector_id = p_id and name = t ->> 'name';
    if cur.name is null then
      insert into connector_tools (connector_id, name, description, input_schema, annotations, policy, locked_reason, badges, review_needed)
      values (p_id, left(t ->> 'name', 128), left(coalesce(t ->> 'description', ''), 4000), coalesce(t -> 'input_schema', '{}'),
              coalesce(t -> 'annotations', '{}'),
              case when p_initial then coalesce(t ->> 'policy', 'ask') else 'off' end,
              lk, coalesce(array(select jsonb_array_elements_text(coalesce(t -> 'badges', '[]'))), '{}'),
              not p_initial);
    elsif cur.description is distinct from left(coalesce(t ->> 'description', ''), 4000) or cur.input_schema is distinct from coalesce(t -> 'input_schema', '{}') then
      update connector_tools set description = left(coalesce(t ->> 'description', ''), 4000), input_schema = coalesce(t -> 'input_schema', '{}'),
        annotations = coalesce(t -> 'annotations', '{}'), policy = 'off', review_needed = true, locked_reason = lk,
        badges = coalesce(array(select jsonb_array_elements_text(coalesce(t -> 'badges', '[]'))), '{}'), updated_at = now()
      where connector_id = p_id and name = cur.name;
    else
      update connector_tools set annotations = coalesce(t -> 'annotations', '{}'), locked_reason = lk,
        policy = case when lk is not null and policy = 'allow' then 'ask' else policy end, updated_at = now()
      where connector_id = p_id and name = cur.name;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Tools an agent may use right now: active MCP connectors granted to it, tools not off and not awaiting review.
create or replace function connector_tools_for_agent(p_agent text)
returns table (connector_id uuid, name text, description text, input_schema jsonb, policy text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform vault_service_guard();
  return query
    select t.connector_id, t.name, t.description, t.input_schema, t.policy
    from connector_tools t
    join connectors c on c.id = t.connector_id and c.kind = 'mcp' and c.status = 'active'
    join connector_grants g on g.connector_id = c.id and g.agent_id = p_agent
    where t.policy <> 'off' and not t.review_needed
    order by c.created_at, t.name;
end $$;

-- ---------- CEO (dashboard) ----------
-- p_policies: {"tool_name": "allow" | "ask" | "off", …}. Locked tools can't be Allowed; any loosening (off → ask/allow,
-- ask → allow) needs a fresh 2FA code. Saving a tool clears its review flag.
create or replace function connector_set_tool_policies(p_id uuid, p_policies jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare k text; v text; cur connector_tools; n int := 0; loosened boolean := false;
begin
  perform hq_guard();
  if not exists (select 1 from connectors where id = p_id and kind = 'mcp') then
    raise exception 'connector_set_tool_policies: unknown MCP connector' using errcode = 'P0002';
  end if;
  for k, v in select key, value #>> '{}' from jsonb_each(coalesce(p_policies, '{}')) loop
    if v not in ('allow', 'ask', 'off') then raise exception 'connector_set_tool_policies: bad policy for %', k using errcode = '22023'; end if;
    select * into cur from connector_tools where connector_id = p_id and name = k;
    if cur.name is null then raise exception 'connector_set_tool_policies: unknown tool %', k using errcode = 'P0002'; end if;
    if cur.locked_reason is not null and v = 'allow' then
      raise exception 'connector_set_tool_policies: % is locked (%) and can''t be Allowed', k, cur.locked_reason using errcode = '22023';
    end if;
    if connector_policy_rank(v) > connector_policy_rank(cur.policy) or (cur.review_needed and v <> 'off') then loosened := true; end if;
  end loop;
  if loosened then perform ceo_step_up_guard(); end if;
  for k, v in select key, value #>> '{}' from jsonb_each(coalesce(p_policies, '{}')) loop
    update connector_tools set policy = v, review_needed = false, updated_at = now() where connector_id = p_id and name = k;
    n := n + 1;
  end loop;
  perform hq_log('ceo', 'connector.tool_policies', null, null, jsonb_build_object('connector_id', p_id, 'policies', p_policies));
  return n;
end $$;

do $$
declare f text;
begin
  execute 'revoke execute on function connector_set_tool_policies(uuid, jsonb) from public, anon';
  execute 'grant execute on function connector_set_tool_policies(uuid, jsonb) to authenticated, service_role';
  foreach f in array array['connector_tools_sync(uuid, jsonb, boolean)', 'connector_tools_for_agent(text)', 'connector_policy_rank(text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
