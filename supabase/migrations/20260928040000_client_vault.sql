-- RizeHub HQ · Client Vault (M9a, docs/09 "Client Vault", docs/04 "Client Vault tools", docs/06 §7a).
-- Secrets are encrypted by the worker (AES-256-GCM envelope, VAULT_MASTER_KEY lives only in the worker env);
-- this file only moves ciphertext around and enforces who may use what.
--
-- Callers
--   CEO (dashboard, authenticated) → vault_set_grants, vault_grant, vault_revoke_grant, vault_revoke,
--                                    vault_update_credential, create_access_request, vault_cancel_access_request
--   worker (service role only)     → vault_log_access, vault_insert_credential, vault_redeem_access_request, vault_rotate_secret,
--                                    vault_get_sealed, vault_get_for_agent, vault_list_for_agent, vault_log_access,
--                                    vault_report_problem, vault_request_2fa, vault_take_2fa_code
-- Functions that return or accept ciphertext are never executable by `authenticated`.

-- ---------- columns ----------
alter table client_credentials add column if not exists failed_login_count int not null default 0;
alter table client_credentials add column if not exists last_used_by text;
alter table client_credentials add column if not exists revoked_at timestamptz;
alter table client_credentials add column if not exists updated_at timestamptz not null default now();
create trigger t_client_credentials_touch before update on client_credentials for each row execute function touch_updated_at();
create index if not exists client_credentials_client on client_credentials (client_id);
create index if not exists credential_access_log_cred on credential_access_log (credential_id, created_at desc);

-- New metadata columns are readable by the dashboard; the secret columns stay unreadable.
grant select (failed_login_count, last_used_by, revoked_at, updated_at) on client_credentials to authenticated;

alter table access_requests add column if not exists created_at timestamptz not null default now();
alter table access_requests add column if not exists note text;
alter table access_requests add column if not exists credential_id uuid references client_credentials(id) on delete set null;
alter table access_requests add column if not exists cancelled_at timestamptz;
create unique index if not exists access_requests_token on access_requests (token_hash);
-- The dashboard sees the link's metadata, never the token hash.
revoke select on access_requests from authenticated, anon;
grant select (id, client_id, platforms, expires_at, used_at, created_at, note, credential_id, cancelled_at) on access_requests to authenticated;
revoke insert, update, delete on access_requests from authenticated, anon;
revoke insert, update, delete on credential_access_log from authenticated, anon;

-- ---------- helpers ----------
-- Service role (worker) or a direct DB session (migrations/tests). Never a browser session, not even the CEO's.
create or replace function vault_service_guard() returns void language plpgsql as $$
begin
  if is_ceo() or not hq_can_operate() then raise exception 'not allowed' using errcode = '42501'; end if;
end $$;

create or replace function vault_platform_ok(p text) returns boolean language sql immutable as $$
  select p ~ '^[a-z0-9][a-z0-9_-]{0,39}$';
$$;

-- One audit row per use + a mirror in activity_log (never secrets). Success on login/api_call updates last used;
-- failed logins count up and flag the credential after 2 (stop retrying so the client's account doesn't lock).
create or replace function vault_log_access(p_credential uuid, p_agent text, p_task uuid, p_action text,
                                            p_success boolean, p_detail jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare c client_credentials; n int; req uuid;
begin
  perform hq_guard();
  if coalesce(p_action, '') !~ '^[a-z_]{1,32}$' then raise exception 'bad action'; end if;
  select * into c from client_credentials where id = p_credential;
  insert into credential_access_log (credential_id, agent_id, task_id, action, success, detail)
  values (p_credential, p_agent, p_task, p_action, coalesce(p_success, false), coalesce(p_detail, '{}'));

  if c.id is not null then
    if p_success and p_action in ('login', 'api_call', 'twofa') then
      update client_credentials set last_used_at = now(), last_used_by = p_agent,
        failed_login_count = case when p_action in ('login', 'twofa') then 0 else failed_login_count end
      where id = c.id;
    elsif p_action = 'failed_login' then
      update client_credentials set failed_login_count = failed_login_count + 1 where id = c.id returning failed_login_count into n;
      if n >= 2 and c.status in ('active', 'expiring') then
        update client_credentials set status = 'check_needed' where id = c.id;
        select request_id into req from tasks where id = p_task;
        insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
        values ('external_action', req, p_task, p_agent, left('Access problem: ' || c.label, 200),
                'Login failed twice, so agents stopped trying (avoids locking the client''s account). Check the password, then rotate it.',
                jsonb_build_object('type', 'vault_problem', 'credential_id', c.id, 'issue', 'failed_login',
                                   'options', jsonb_build_array('rotate', 'revoke')));
        if p_agent is not null then perform refresh_agent_status(p_agent); end if;
      end if;
    end if;
  end if;

  select request_id into req from tasks where id = p_task;
  insert into activity_log (actor, action, request_id, task_id, client_id, detail)
  values (coalesce(p_agent, 'system'), 'vault.' || p_action, req, p_task, c.client_id,
          jsonb_build_object('credential_id', p_credential, 'label', c.label, 'platform', c.platform,
                             'success', coalesce(p_success, false)) || coalesce(p_detail, '{}'));
end $$;

-- ---------- storing (worker only: ciphertext in) ----------
create or replace function vault_insert_credential(
  p_id uuid, p_client uuid, p_platform text, p_label text, p_login_url text, p_username text, p_secret_type text,
  p_cipher bytea, p_iv bytea, p_key_version int, p_twofa text default 'none', p_scope_notes text default null,
  p_url_allowlist text[] default '{}', p_expires_at timestamptz default null, p_created_by text default 'ceo',
  p_grants text[] default '{}')
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
  insert into client_credentials (id, client_id, platform, label, login_url, username, secret_type, secret_cipher, secret_iv,
                                  key_version, twofa_method, scope_notes, url_allowlist, expires_at, created_by)
  values (coalesce(p_id, gen_random_uuid()), cl.id, p_platform, left(trim(p_label), 120), nullif(trim(p_login_url), ''),
          nullif(trim(p_username), ''), p_secret_type, p_cipher, p_iv, coalesce(p_key_version, 1), coalesce(p_twofa, 'none'),
          nullif(trim(p_scope_notes), ''), coalesce(p_url_allowlist, '{}'), p_expires_at, coalesce(p_created_by, 'ceo'))
  returning id into p_id;
  foreach g in array coalesce(p_grants, '{}') loop
    insert into credential_grants (credential_id, agent_id)
    select p_id, a.id from agents a where a.id = g on conflict do nothing;
  end loop;
  perform vault_log_access(p_id, case when p_created_by = 'client_link' then 'client' else 'ceo' end, null, 'store', true,
                           jsonb_build_object('grants', coalesce(p_grants, '{}')));
  return p_id;
end $$;

create or replace function vault_rotate_secret(p_id uuid, p_cipher bytea, p_iv bytea, p_key_version int)
returns void language plpgsql security definer set search_path = public as $$
declare c client_credentials;
begin
  perform vault_service_guard();
  select * into c from client_credentials where id = p_id for update;
  if c.id is null then raise exception 'credential not found'; end if;
  if c.status = 'revoked' then raise exception 'credential is revoked; add a new one instead'; end if;
  update client_credentials set secret_cipher = p_cipher, secret_iv = p_iv, key_version = p_key_version,
    failed_login_count = 0, status = 'active' where id = p_id;
  perform vault_log_access(p_id, 'ceo', null, 'rotate', true, '{}');
end $$;

-- ---------- secure client link ----------
-- The dashboard generates a random token, keeps it only long enough to show the link, and passes its SHA-256 here.
create or replace function create_access_request(p_client uuid, p_platforms text[], p_token_hash text,
                                                 p_hours int default 72, p_note text default null)
returns access_requests language plpgsql security definer set search_path = public as $$
declare r access_requests; cl clients; p text;
begin
  perform hq_guard();
  select * into cl from clients where id = p_client;
  if cl.id is null then raise exception 'client not found'; end if;
  if cl.status = 'archived' then raise exception 'client is archived'; end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'bad token hash'; end if;
  if coalesce(array_length(p_platforms, 1), 0) = 0 then raise exception 'pick at least one platform'; end if;
  foreach p in array p_platforms loop
    if not vault_platform_ok(p) then raise exception 'bad platform'; end if;
  end loop;
  insert into access_requests (client_id, token_hash, platforms, expires_at, note)
  values (cl.id, p_token_hash, p_platforms, now() + make_interval(hours => greatest(1, least(coalesce(p_hours, 72), 72))),
          nullif(left(trim(p_note), 500), ''))
  returning * into r;
  insert into activity_log (actor, action, client_id, detail)
  values ('ceo', 'vault.access_link', cl.id, jsonb_build_object('access_request_id', r.id, 'platforms', p_platforms, 'expires_at', r.expires_at));
  r.token_hash := null;  -- never echo it back
  return r;
end $$;

create or replace function vault_cancel_access_request(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform hq_guard();
  update access_requests set cancelled_at = now() where id = p_id and used_at is null and cancelled_at is null;
end $$;

-- Public form → worker: atomically checks the token (exists, not used, not cancelled, not expired), marks it used
-- and stores the credential. Returns null for any bad token so callers can't tell the cases apart.
create or replace function vault_redeem_access_request(
  p_token_hash text, p_id uuid, p_platform text, p_label text, p_login_url text, p_username text, p_secret_type text,
  p_cipher bytea, p_iv bytea, p_key_version int, p_twofa text default 'none', p_scope_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare r access_requests; cid uuid;
begin
  perform vault_service_guard();
  update access_requests set used_at = now()
   where token_hash = p_token_hash and used_at is null and cancelled_at is null and expires_at > now()
  returning * into r;
  if r.id is null then return null; end if;
  if not (p_platform = any (r.platforms) or 'other' = any (r.platforms)) then
    raise exception 'platform not requested';
  end if;
  cid := vault_insert_credential(p_id, r.client_id, p_platform, p_label, p_login_url, p_username, p_secret_type,
                                 p_cipher, p_iv, p_key_version, p_twofa, p_scope_notes, '{}', null, 'client_link', '{}');
  update access_requests set credential_id = cid where id = r.id;
  return cid;
end $$;

-- Read-only check used by the public page to show "expired / already used" before the client types anything.
create or replace function vault_access_request_state(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r access_requests; cl clients;
begin
  perform vault_service_guard();
  select * into r from access_requests where token_hash = p_token_hash;
  if r.id is null then return jsonb_build_object('state', 'invalid'); end if;
  select * into cl from clients where id = r.client_id;
  return jsonb_build_object(
    'state', case when r.used_at is not null then 'used' when r.cancelled_at is not null or cl.status = 'archived' then 'invalid'
                  when r.expires_at <= now() then 'expired' else 'open' end,
    'client_name', cl.name, 'platforms', r.platforms, 'expires_at', r.expires_at, 'note', r.note);
end $$;

-- ---------- grants (CEO) ----------
create or replace function vault_set_grants(p_credential uuid, p_agents text[]) returns text[]
language plpgsql security definer set search_path = public as $$
declare c client_credentials; cl clients; out text[];
begin
  perform hq_guard();
  select * into c from client_credentials where id = p_credential;
  if c.id is null then raise exception 'credential not found'; end if;
  select * into cl from clients where id = c.client_id;
  if c.status = 'revoked' and coalesce(array_length(p_agents, 1), 0) > 0 then raise exception 'credential is revoked'; end if;
  if cl.status = 'archived' and coalesce(array_length(p_agents, 1), 0) > 0 then raise exception 'client is archived'; end if;
  delete from credential_grants where credential_id = c.id and not (agent_id = any (coalesce(p_agents, '{}')));
  insert into credential_grants (credential_id, agent_id)
  select c.id, a.id from agents a where a.id = any (coalesce(p_agents, '{}')) on conflict do nothing;
  select coalesce(array_agg(agent_id order by agent_id), '{}') into out from credential_grants where credential_id = c.id;
  perform vault_log_access(c.id, 'ceo', null, 'grants', true, jsonb_build_object('agents', out));
  return out;
end $$;

create or replace function vault_grant(p_credential uuid, p_agent text) returns void
language plpgsql security definer set search_path = public as $$
declare cur text[];
begin
  perform hq_guard();
  select coalesce(array_agg(agent_id), '{}') into cur from credential_grants where credential_id = p_credential;
  perform vault_set_grants(p_credential, array_append(cur, p_agent));
end $$;

create or replace function vault_revoke_grant(p_credential uuid, p_agent text) returns void
language plpgsql security definer set search_path = public as $$
declare cur text[];
begin
  perform hq_guard();
  select coalesce(array_agg(agent_id), '{}') into cur from credential_grants where credential_id = p_credential;
  perform vault_set_grants(p_credential, array_remove(cur, p_agent));
end $$;

-- ---------- status transitions ----------
-- Revoke: nobody can use it any more (grants dropped). The CEO still has to revoke it at the platform.
create or replace function vault_revoke(p_credential uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare c client_credentials;
begin
  perform hq_guard();
  update client_credentials set status = 'revoked', revoked_at = now() where id = p_credential and status <> 'revoked' returning * into c;
  if c.id is null then return; end if;
  delete from credential_grants where credential_id = c.id;
  perform vault_log_access(c.id, 'ceo', null, 'revoke', true, jsonb_build_object('reason', nullif(trim(p_reason), '')));
end $$;

-- Metadata edits from the dashboard (never the secret; that goes through the worker's /vault/rotate).
create or replace function vault_update_credential(p_id uuid, p_label text, p_login_url text, p_username text,
  p_twofa text, p_scope_notes text, p_url_allowlist text[], p_expires_at timestamptz, p_platform text default null,
  p_status text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c client_credentials;
begin
  perform hq_guard();
  select * into c from client_credentials where id = p_id for update;
  if c.id is null then raise exception 'credential not found'; end if;
  if coalesce(trim(p_label), '') = '' then raise exception 'label is required'; end if;
  if p_platform is not null and not vault_platform_ok(p_platform) then raise exception 'bad platform'; end if;
  -- only "check needed → active" (after the CEO fixed it) and "→ expiring" may be set here; revoke has its own function.
  if p_status is not null and p_status not in ('active', 'expiring') then raise exception 'use vault_revoke to revoke'; end if;
  if p_status is not null and c.status = 'revoked' then raise exception 'credential is revoked'; end if;
  update client_credentials set label = left(trim(p_label), 120), login_url = nullif(trim(p_login_url), ''),
    username = nullif(trim(p_username), ''), twofa_method = coalesce(p_twofa, twofa_method),
    scope_notes = nullif(trim(p_scope_notes), ''), url_allowlist = coalesce(p_url_allowlist, '{}'), expires_at = p_expires_at,
    platform = coalesce(p_platform, platform),
    status = coalesce(p_status, status), failed_login_count = case when p_status = 'active' then 0 else failed_login_count end
  where id = p_id;
  perform vault_log_access(p_id, 'ceo', null, 'edit', true, '{}');
end $$;

-- ---------- agent side (worker only) ----------
-- Metadata of this client's credentials that the agent is granted (never ciphertext) + how many others exist.
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
        'url_allowlist', c.url_allowlist, 'status', c.status, 'expires_at', c.expires_at, 'last_used_at', c.last_used_at)
        order by c.platform, c.label), '[]')
      from client_credentials c join credential_grants g on g.credential_id = c.id and g.agent_id = p_agent
      where c.client_id = cl.id and c.status <> 'revoked' and cl.status <> 'archived'),
    'not_granted', (select count(*) from client_credentials c where c.client_id = cl.id and c.status <> 'revoked'
      and not exists (select 1 from credential_grants g where g.credential_id = c.id and g.agent_id = p_agent)));
end $$;

-- The one place ciphertext leaves the database for an agent: only with a grant, only while usable.
create or replace function vault_get_for_agent(p_credential uuid, p_agent text)
returns table (id uuid, client_id uuid, platform text, label text, login_url text, username text, secret_type text,
               secret_cipher bytea, secret_iv bytea, key_version int, twofa_method text, scope_notes text,
               url_allowlist text[], status text, failed_login_count int)
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
    c.secret_iv, c.key_version, c.twofa_method, c.scope_notes, c.url_allowlist, c.status, c.failed_login_count;
end $$;

-- CEO reveal / rotate path in the worker (the dashboard re-authenticated the CEO before calling the worker).
create or replace function vault_get_sealed(p_credential uuid)
returns table (id uuid, client_id uuid, label text, secret_cipher bytea, secret_iv bytea, key_version int, status text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform vault_service_guard();
  return query select c.id, c.client_id, c.label, c.secret_cipher, c.secret_iv, c.key_version, c.status
    from client_credentials c where c.id = p_credential;
end $$;

-- An agent hit a wrong password / expired token / locked account: flag it and ask the CEO.
create or replace function vault_report_problem(p_credential uuid, p_agent text, p_task uuid, p_issue text)
returns uuid language plpgsql security definer set search_path = public as $$
declare c client_credentials; aid uuid; req uuid; issue text := left(coalesce(nullif(trim(p_issue), ''), 'unspecified problem'), 1000);
begin
  perform vault_service_guard();
  select * into c from client_credentials where id = p_credential;
  if c.id is null then raise exception 'vault: credential not found'; end if;
  if not exists (select 1 from credential_grants g where g.credential_id = c.id and g.agent_id = p_agent) then
    raise exception 'vault: not granted';
  end if;
  if c.status in ('active', 'expiring') then update client_credentials set status = 'check_needed' where id = c.id; end if;
  select request_id into req from tasks where id = p_task;
  insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
  values ('external_action', req, p_task, p_agent, left('Access problem: ' || c.label, 200), issue,
          jsonb_build_object('type', 'vault_problem', 'credential_id', c.id, 'issue', issue,
                             'options', jsonb_build_array('rotate', 'revoke')))
  returning id into aid;
  perform vault_log_access(c.id, p_agent, p_task, 'problem', false, jsonb_build_object('issue', issue, 'approval_id', aid));
  perform refresh_agent_status(p_agent);
  return aid;
end $$;

-- 2FA: a question approval the CEO answers with the code (Telegram asks for a typed answer on type 'question').
-- The task keeps running (the tool waits), so a fresh login code isn't wasted by a new session.
create or replace function vault_request_2fa(p_credential uuid, p_agent text, p_task uuid, p_question text)
returns uuid language plpgsql security definer set search_path = public as $$
declare c client_credentials; aid uuid; req uuid;
begin
  perform vault_service_guard();
  select * into c from client_credentials where id = p_credential;
  if c.id is null then raise exception 'vault: credential not found'; end if;
  if not exists (select 1 from credential_grants g where g.credential_id = c.id and g.agent_id = p_agent) then
    raise exception 'vault: not granted';
  end if;
  select request_id into req from tasks where id = p_task;
  insert into approvals (kind, request_id, task_id, agent_id, title, summary, payload)
  values ('external_action', req, p_task, p_agent, left('2FA code needed: ' || c.label, 200), p_question,
          jsonb_build_object('type', 'question', 'question', p_question, 'options', '[]'::jsonb,
                             'vault', jsonb_build_object('kind', '2fa', 'credential_id', c.id)))
  returning id into aid;
  perform vault_log_access(c.id, p_agent, p_task, 'twofa_request', true, jsonb_build_object('approval_id', aid));
  perform refresh_agent_status(p_agent);
  return aid;
end $$;

-- Returns {status} while pending, {status:'approved', code} once answered; the code is then scrubbed from the
-- approval and the activity log so it never lingers anywhere.
create or replace function vault_take_2fa_code(p_approval uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ap approvals; code text;
begin
  perform vault_service_guard();
  select * into ap from approvals where id = p_approval and payload -> 'vault' ->> 'kind' = '2fa' for update;
  if ap.id is null then raise exception 'vault: not a 2FA request'; end if;
  if ap.status = 'pending' then return jsonb_build_object('status', 'pending'); end if;
  if ap.status <> 'approved' or coalesce(ap.ceo_note, '') in ('', '[2FA code used]') then
    return jsonb_build_object('status', case when ap.ceo_note = '[2FA code used]' then 'used' else ap.status::text end);
  end if;
  code := ap.ceo_note;
  update approvals set ceo_note = '[2FA code used]' where id = ap.id;
  update activity_log set detail = detail || jsonb_build_object('note', '[2FA code used]')
   where action like 'approval.%' and detail ->> 'approval_id' = ap.id::text;
  if ap.agent_id is not null then perform refresh_agent_status(ap.agent_id); end if;
  return jsonb_build_object('status', 'approved', 'code', code);
end $$;

-- ---------- archiving a client revokes every grant ----------
create or replace function vault_on_client_archived() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if new.status = 'archived' and old.status is distinct from 'archived' then
    for c in select distinct cc.id from client_credentials cc join credential_grants g on g.credential_id = cc.id
             where cc.client_id = new.id loop
      delete from credential_grants where credential_id = c.id;
      perform vault_log_access(c.id, 'system', null, 'revoke', true, jsonb_build_object('reason', 'client_archived'));
    end loop;
    update access_requests set cancelled_at = now() where client_id = new.id and used_at is null and cancelled_at is null;
  end if;
  return new;
end $$;
create trigger t_clients_archived after update of status on clients for each row execute function vault_on_client_archived();

-- ---------- permissions ----------
do $$
declare f text;
begin
  -- CEO (dashboard) + worker
  foreach f in array array['vault_set_grants(uuid,text[])', 'vault_grant(uuid,text)', 'vault_revoke_grant(uuid,text)',
    'vault_revoke(uuid,text)', 'vault_update_credential(uuid,text,text,text,text,text,text[],timestamptz,text,text)',
    'create_access_request(uuid,text[],text,int,text)', 'vault_cancel_access_request(uuid)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  -- worker only: these read or write ciphertext, or act as an agent
  foreach f in array array['vault_service_guard()', 'vault_log_access(uuid,text,uuid,text,boolean,jsonb)', 'vault_insert_credential(uuid,uuid,text,text,text,text,text,bytea,bytea,int,text,text,text[],timestamptz,text,text[])',
    'vault_rotate_secret(uuid,bytea,bytea,int)',
    'vault_redeem_access_request(text,uuid,text,text,text,text,text,bytea,bytea,int,text,text)',
    'vault_access_request_state(text)', 'vault_list_for_agent(text,uuid)', 'vault_get_for_agent(uuid,text)',
    'vault_get_sealed(uuid)', 'vault_report_problem(uuid,text,uuid,text)', 'vault_request_2fa(uuid,text,uuid,text)',
    'vault_take_2fa_code(uuid)', 'vault_on_client_archived()']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
