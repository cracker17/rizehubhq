-- Admin → API & AI (docs/14 "Dashboard settings", docs/09 "Where system secrets live").
-- 1. provider_keys: AI / research / design API keys the CEO manages in the dashboard instead of the VPS .env. Sealed by
--    the worker with the vault keyring (context 'provider_key:<NAME>'), stored as ciphertext, never readable by the
--    browser. Only a fixed allowlist of provider key names (packages/shared/src/aiSettings.ts PROVIDER_KEYS); bootstrap
--    secrets (SUPABASE_*, VAULT_*, HQ_INTERNAL_SECRET, TELEGRAM_BOT_TOKEN, …) can never be stored here.
-- 2. AI settings (non-secret) in `settings` under ai_model_profile / ai_monthly_budget_usd / ai_daily_budget_usd /
--    ai_model_ids, written only through ai_settings_set() (audited; raising a budget needs a fresh 2FA code).
--    A dashboard value wins over the .env value; the .env value is the default (docs/14).

create table provider_keys (
  name          text primary key check (name in (
                  'GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
                  'MOONSHOT_API_KEY', 'TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'PAGESPEED_API_KEY',
                  'SEMRUSH_API_KEY', 'FIGMA_TOKEN')),
  cipher        bytea not null,
  iv            bytea not null,
  key_version   int not null check (key_version >= 1),
  last4         text not null check (char_length(last4) <= 4),
  updated_at    timestamptz not null default now(),
  last_test_at  timestamptz,
  last_test_ok  boolean,
  last_error    text
);

alter table provider_keys enable row level security;
create policy ceo_read on provider_keys for select to authenticated using (is_ceo());
-- The dashboard reads which keys are set (name, last 4 characters, test result); never the ciphertext.
revoke all on provider_keys from authenticated, anon;
grant select (name, last4, updated_at, last_test_at, last_test_ok, last_error) on provider_keys to authenticated;

-- ---------- worker only (ciphertext) ----------
create or replace function provider_key_upsert(p_name text, p_cipher bytea, p_iv bytea, p_key_version int, p_last4 text,
                                               p_test_ok boolean default null, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
declare existed boolean;
begin
  perform vault_service_guard();
  select exists (select 1 from provider_keys where name = p_name) into existed;
  insert into provider_keys (name, cipher, iv, key_version, last4, updated_at, last_test_at, last_test_ok, last_error)
  values (p_name, p_cipher, p_iv, p_key_version, right(coalesce(p_last4, ''), 4), now(),
          case when p_test_ok is null then null else now() end, p_test_ok, left(p_error, 300))
  on conflict (name) do update set
    cipher = excluded.cipher, iv = excluded.iv, key_version = excluded.key_version, last4 = excluded.last4,
    updated_at = now(), last_test_at = excluded.last_test_at, last_test_ok = excluded.last_test_ok, last_error = excluded.last_error;
  perform hq_log('ceo', case when existed then 'provider_key.replaced' else 'provider_key.added' end, null, null,
                 jsonb_build_object('name', p_name, 'tested', p_test_ok));
end $$;

create or replace function provider_key_mark_test(p_name text, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform vault_service_guard();
  update provider_keys set last_test_at = now(), last_test_ok = p_ok, last_error = case when p_ok then null else left(p_error, 300) end
  where name = p_name;
end $$;

-- Every stored key, sealed (decrypted only inside the worker, every ~60 s and on /settings/reload).
create or replace function provider_keys_sealed()
returns table (name text, cipher bytea, iv bytea, key_version int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform vault_service_guard();
  return query select k.name, k.cipher, k.iv, k.key_version from provider_keys k order by k.name;
end $$;

-- ---------- CEO (dashboard) ----------
create or replace function provider_key_delete(p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  delete from provider_keys where name = p_name;
  if not found then raise exception 'provider_key_delete: no key stored under that name' using errcode = 'P0002'; end if;
  perform hq_log('ceo', 'provider_key.removed', null, null, jsonb_build_object('name', p_name));
end $$;

-- ---------- AI settings ----------
-- Does going from (before) to (after) allow more spending? null = "use the .env value" (unknown here, so setting a
-- figure where there was none, or clearing one, counts as loosening). Daily 0 = no cap = unlimited; monthly 0 = floor.
-- Mirrors budgetLoosened() in packages/shared/src/aiSettings.ts.
create or replace function ai_budget_looser(p_before numeric, p_after numeric, p_zero_is_unlimited boolean)
returns boolean language sql immutable set search_path = public as $$
  select case
    when p_after is null then p_before is not null
    when p_before is null then not (p_after = 0 and not p_zero_is_unlimited)
    when p_zero_is_unlimited then
      (case when p_after = 0 then 'infinity'::numeric else p_after end) > (case when p_before = 0 then 'infinity'::numeric else p_before end)
    else p_after > p_before
  end;
$$;

create or replace function ai_setting_num(p_key text) returns numeric
language sql stable security definer set search_path = public as $$
  select case when jsonb_typeof(value) = 'number' then (value #>> '{}')::numeric end from settings where key = p_key;
$$;

-- Full replace of the CEO's AI settings: null (or {} for model ids) = no dashboard value, the .env value applies.
create or replace function ai_settings_set(p_profile text, p_monthly numeric, p_daily numeric, p_model_ids jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ids jsonb := coalesce(p_model_ids, '{}'::jsonb);
  r text;
  before jsonb;
  after jsonb;
begin
  perform hq_guard();
  if p_profile is not null and p_profile not in ('free', 'paid', 'hybrid', 'claude', 'openai', 'kimi') then
    raise exception 'ai_settings_set: unknown model profile' using errcode = '22023';
  end if;
  if (p_monthly is not null and (p_monthly < 0 or p_monthly > 100000)) or (p_daily is not null and (p_daily < 0 or p_daily > 100000)) then
    raise exception 'ai_settings_set: budgets must be between 0 and 100000 USD' using errcode = '22023';
  end if;
  if jsonb_typeof(ids) <> 'object' then raise exception 'ai_settings_set: model ids must be an object' using errcode = '22023'; end if;
  for r in select jsonb_object_keys(ids) loop
    if r not in ('lead', 'specialist', 'dev', 'design', 'writer', 'sales', 'reports', 'qa', 'light') then
      raise exception 'ai_settings_set: unknown role %', r using errcode = '22023';
    end if;
    if jsonb_typeof(ids -> r) <> 'string'
       or (ids ->> r) !~ '^(google|groq|openrouter|anthropic|openai|moonshot):[A-Za-z0-9][-\w./:@+]{0,119}$' then
      raise exception 'ai_settings_set: model for % must be provider:model', r using errcode = '22023';
    end if;
  end loop;

  -- More money may be spent → the CEO confirms with a fresh 2FA code.
  if ai_budget_looser(ai_setting_num('ai_monthly_budget_usd'), p_monthly, false)
     or ai_budget_looser(ai_setting_num('ai_daily_budget_usd'), p_daily, true) then
    perform ceo_step_up_guard();
  end if;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into before from settings where key like 'ai\_%';
  delete from settings where key in ('ai_model_profile', 'ai_monthly_budget_usd', 'ai_daily_budget_usd', 'ai_model_ids');
  if p_profile is not null then insert into settings (key, value) values ('ai_model_profile', to_jsonb(p_profile)); end if;
  if p_monthly is not null then insert into settings (key, value) values ('ai_monthly_budget_usd', to_jsonb(p_monthly)); end if;
  if p_daily is not null then insert into settings (key, value) values ('ai_daily_budget_usd', to_jsonb(p_daily)); end if;
  if ids <> '{}'::jsonb then insert into settings (key, value) values ('ai_model_ids', ids); end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into after from settings where key like 'ai\_%';
  if after is distinct from before then
    perform hq_log('ceo', 'ai_settings.updated', null, null, jsonb_build_object('before', before, 'after', after));
  end if;
  return after;
end $$;

-- The CEO may still edit other settings rows directly (RLS ceo_all), but never the ai_* rows: those go through
-- ai_settings_set() so the 2FA rule and the audit row can't be skipped. (The service role bypasses RLS.)
create policy ai_rows_via_rpc_insert on settings as restrictive for insert to authenticated with check (not starts_with(key, 'ai_'));
create policy ai_rows_via_rpc_update on settings as restrictive for update to authenticated
  using (not starts_with(key, 'ai_')) with check (not starts_with(key, 'ai_'));
create policy ai_rows_via_rpc_delete on settings as restrictive for delete to authenticated using (not starts_with(key, 'ai_'));

do $$
declare f text;
begin
  foreach f in array array['provider_key_delete(text)', 'ai_settings_set(text, numeric, numeric, jsonb)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'provider_key_upsert(text, bytea, bytea, int, text, boolean, text)', 'provider_key_mark_test(text, boolean, text)',
    'provider_keys_sealed()', 'ai_budget_looser(numeric, numeric, boolean)', 'ai_setting_num(text)']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
