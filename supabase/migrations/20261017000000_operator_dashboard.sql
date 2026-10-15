-- Julev Operator phase 3, milestone 1 (docs/17-OPERATOR.md "Phase 3"): the CEO runs the operator from /operator.
--   * per-client autonomy editing: operator_set_autonomy(client | '*', action type, auto | approve | never | inherit)
--   * the auto-send master switch: operator_set_auto_send(on)
--   * jobs list + Add task use the phase 2 functions (operator_add_job / operator_cancel_job) and the CEO's read access
-- Builds on 20261015000000_operator.sql and 20261016000000_operator_worker.sql.

-- Action types that may never post by themselves, whatever the CEO sets: they change money, publish, delete, make
-- promises or hand out secrets. They can be 'approve' or 'never' (credentials: 'never' only).
create or replace function operator_auto_allowed(p_action text) returns boolean
language sql immutable set search_path = public as $$
  select p_action in ('ack', 'status', 'thanks', 'factual', 'reply', 'task');
$$;

create or replace function operator_set_autonomy(p_client text, p_action text, p_mode text) returns text
language plpgsql security definer set search_path = public as $$
declare c text := coalesce(nullif(btrim(p_client), ''), '*'); m text := lower(btrim(coalesce(p_mode, ''))); before text;
begin
  perform hq_guard();
  if c <> '*' and not exists (select 1 from operator_clients where slug = c) then raise exception 'unknown client %', c; end if;
  if p_action not in ('ack', 'status', 'thanks', 'factual', 'reply', 'task', 'publish', 'deadline', 'commitment', 'money',
                      'new_contact', 'delete', 'credentials') then
    raise exception 'unknown action type %', p_action;
  end if;
  if m not in ('auto', 'approve', 'never', 'inherit') then raise exception 'mode must be auto, approve, never or inherit'; end if;
  if m = 'auto' and not operator_auto_allowed(p_action) then
    raise exception '% can never post by itself: choose approve or never', p_action;
  end if;
  if p_action = 'credentials' and m not in ('never', 'inherit') then raise exception 'credentials stay never'; end if;
  if m = 'inherit' and c = '*' then raise exception 'the default rules cannot inherit: pick auto, approve or never'; end if;
  before := operator_mode_for(c, p_action);
  if m = 'inherit' then
    delete from operator_autonomy where client_slug = c and action_type = p_action;
  else
    insert into operator_autonomy (client_slug, action_type, mode, updated_at) values (c, p_action, m, now())
    on conflict (client_slug, action_type) do update set mode = excluded.mode, updated_at = now();
  end if;
  perform operator_log('ceo', 'autonomy.changed', nullif(c, '*'), null,
                       jsonb_build_object('client', c, 'action_type', p_action, 'mode', m, 'before', before, 'now', operator_mode_for(c, p_action)));
  return operator_mode_for(c, p_action);
end $$;

create or replace function operator_set_auto_send(p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  insert into settings (key, value) values ('operator_auto_send', to_jsonb(coalesce(p_on, false)))
  on conflict (key) do update set value = excluded.value;
  perform operator_log('ceo', case when p_on then 'autosend.on' else 'autosend.off' end, null, null, '{}');
  return coalesce(p_on, false);
end $$;

do $$
declare f text;
begin
  foreach f in array array['operator_set_autonomy(text,text,text)', 'operator_set_auto_send(boolean)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
revoke execute on function operator_auto_allowed(text) from public, anon, authenticated;
grant execute on function operator_auto_allowed(text) to service_role;
