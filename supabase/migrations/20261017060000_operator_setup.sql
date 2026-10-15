-- Julev Operator phase 3, milestone 6c (docs/17-OPERATOR.md "Setup wizard"): add and set up a client from /operator
-- instead of SQL. The wizard uses these plus the existing CEO functions (operator_set_viewer_url, operator_set_login_site,
-- operator_add_account, operator_add_watch / operator_add_whatsapp, operator_set_credential).
--   operator_save_client          create or update a client (name, brain project, how Julev appears, rules)
--   operator_request_login_check  "Check now" in the wizard: the operator checks that client's logins within a minute

alter table operator_clients add column if not exists login_check_requested_at timestamptz;

create or replace function operator_save_client(p_slug text, p_name text, p_brain_project text, p_my_names text[], p_rules text) returns text
language plpgsql security definer set search_path = public as $$
declare s text := lower(btrim(coalesce(p_slug, ''))); n text := left(btrim(coalesce(p_name, '')), 120);
        bp text := nullif(lower(btrim(coalesce(p_brain_project, ''))), ''); names text[];
begin
  perform hq_guard();
  if s !~ '^[a-z0-9][a-z0-9-]{0,63}$' then raise exception 'the short name must be lowercase letters, digits and dashes (e.g. madam-muse)'; end if;
  if n = '' then raise exception 'give the client a name'; end if;
  if bp is not null and bp !~ '^[a-z0-9][a-z0-9-]{0,63}$' then raise exception 'the brain project must be a project slug (e.g. madam-muse)'; end if;
  select coalesce(array_agg(left(btrim(x), 80)) filter (where btrim(x) <> ''), '{}') into names from unnest(coalesce(p_my_names, '{}')) x;
  if cardinality(names) = 0 then names := array['Julev', 'Julev Ajeto']; end if;
  insert into operator_clients (slug, name, brain_project, profile, my_names, rules, client_id)
  values (s, n, bp, s, names, left(coalesce(p_rules, ''), 4000), (select id from clients where slug = s limit 1))
  on conflict (slug) do update set name = excluded.name, brain_project = excluded.brain_project, my_names = excluded.my_names,
                                   rules = case when btrim(coalesce(p_rules, '')) = '' then operator_clients.rules else excluded.rules end;
  perform operator_log('ceo', 'client.saved', s, null, jsonb_build_object('name', n));
  return s;
end $$;

create or replace function operator_request_login_check(p_client text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  update operator_clients set login_check_requested_at = now() where slug = p_client;
  if not found then raise exception 'unknown client %', p_client; end if;
end $$;

-- The operator takes the pending requests (and clears them) every minute.
create or replace function operator_take_login_checks() returns text[]
language plpgsql security definer set search_path = public as $$
declare out text[];
begin
  perform hq_guard();
  with t as (update operator_clients set login_check_requested_at = null where login_check_requested_at is not null returning slug)
  select coalesce(array_agg(slug), '{}') into out from t;
  return out;
end $$;

do $$
begin
  execute 'revoke execute on function operator_take_login_checks() from public, anon, authenticated';
  execute 'grant execute on function operator_take_login_checks() to service_role';
  execute 'revoke execute on function operator_save_client(text,text,text,text[],text) from public, anon';
  execute 'grant execute on function operator_save_client(text,text,text,text[],text) to authenticated, service_role';
  execute 'revoke execute on function operator_request_login_check(text) from public, anon';
  execute 'grant execute on function operator_request_login_check(text) to authenticated, service_role';
end $$;
