-- Julev Operator phase 3, milestone 7 (docs/17-OPERATOR.md "GitHub and Vercel"): jobs read a client's GitHub repos
-- and Vercel projects through their APIs (issues, PRs, commits, workflow runs, files; projects, deployments, build
-- logs, domains) and PROPOSE changes for the CEO's ✅ like Webflow / Airtable:
--   github_issue {repo, title, body, labels?} · github_comment {repo, number, body} · github_merge {repo, number, method?}
--   vercel_redeploy {deployment_id, target?} · vercel_promote {project, deployment_id}
-- Tokens: the client's Client Vault credentials (linked in the setup wizard) or OPERATOR_GITHUB_TOKEN_<CLIENT> /
-- OPERATOR_VERCEL_TOKEN_<CLIENT>; Vercel team projects need the team id (wizard, or OPERATOR_VERCEL_TEAM_<CLIENT>).

alter table operator_clients add column if not exists github_credential uuid references client_credentials(id) on delete set null;
alter table operator_clients add column if not exists vercel_credential uuid references client_credentials(id) on delete set null;
alter table operator_clients add column if not exists vercel_team text check (vercel_team is null or vercel_team ~ '^[A-Za-z0-9_-]{2,64}$');

alter table operator_job_actions drop constraint if exists operator_job_actions_kind_check;
alter table operator_job_actions add constraint operator_job_actions_kind_check
  check (kind in ('webflow_cms', 'webflow_publish', 'airtable_write', 'browser_click', 'delete', 'other',
                  'github_issue', 'github_comment', 'github_merge', 'vercel_redeploy', 'vercel_promote'));

-- Same as 20261016000000_operator_worker.sql, with the new approval titles.
create or replace function operator_request_action(p_job uuid, p_kind text, p_summary text, p_spec jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare j operator_jobs; c operator_clients; aid uuid; xid uuid; s text := left(btrim(coalesce(p_summary, '')), 1000);
begin
  perform hq_guard();
  select * into j from operator_jobs where id = p_job for update;
  if j.id is null then raise exception 'unknown job'; end if;
  if j.status <> 'running' then raise exception 'the job is not running (%)', j.status; end if;
  if length(s) < 3 then raise exception 'say what the action does'; end if;
  if (select count(*) from operator_job_actions where job_id = j.id and status in ('pending', 'approved', 'executing')) >= 20 then
    raise exception 'too many actions waiting for this job';
  end if;
  select * into c from operator_clients where slug = j.client_slug;
  insert into operator_job_actions (job_id, client_slug, kind, summary, spec)
  values (j.id, j.client_slug, p_kind, s, coalesce(p_spec, '{}')) returning id into xid;
  insert into approvals (kind, title, summary, payload)
  values ('external_action',
          left(case p_kind when 'webflow_publish' then 'Publish' when 'webflow_cms' then 'Webflow CMS change'
                           when 'airtable_write' then 'Airtable change' when 'browser_click' then 'Click in the browser'
                           when 'delete' then 'Delete' when 'github_issue' then 'New GitHub issue'
                           when 'github_comment' then 'GitHub comment' when 'github_merge' then 'Merge pull request'
                           when 'vercel_redeploy' then 'Redeploy on Vercel' when 'vercel_promote' then 'Promote to production'
                           else 'Action' end || ' (' || c.name || '): ' || s, 200),
          s,
          jsonb_build_object('type', 'operator_action', 'action_id', xid, 'job_id', j.id, 'job_title', j.title,
                             'client', c.slug, 'client_name', c.name, 'action_kind', p_kind, 'spec', coalesce(p_spec, '{}')))
  returning id into aid;
  update operator_job_actions set approval_id = aid where id = xid;
  perform operator_log_job('operator', 'action.requested', j.client_slug, j.id, jsonb_build_object('action_id', xid, 'kind', p_kind, 'summary', left(s, 300), 'approval_id', aid));
  return jsonb_build_object('action_id', xid, 'approval_id', aid);
end $$;

create or replace function operator_set_credential(p_client text, p_platform text, p_credential uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c operator_clients; cr client_credentials;
begin
  perform hq_guard();
  perform ceo_step_up_guard();
  select * into c from operator_clients where slug = p_client for update;
  if c.slug is null then raise exception 'unknown client %', p_client; end if;
  if p_platform not in ('webflow', 'airtable', 'github', 'vercel') then raise exception 'platform must be webflow, airtable, github or vercel'; end if;
  if p_credential is not null then
    select * into cr from client_credentials where id = p_credential;
    if cr.id is null then raise exception 'unknown credential'; end if;
    if lower(cr.platform) <> p_platform then raise exception 'that credential is for %, not %', cr.platform, p_platform; end if;
    if cr.secret_type not in ('api_token', 'other') then raise exception 'the operator needs an API token, not a %', cr.secret_type; end if;
    if c.client_id is not null and cr.client_id <> c.client_id then raise exception 'that credential belongs to another client'; end if;
  end if;
  case p_platform
    when 'webflow' then update operator_clients set webflow_credential = p_credential where slug = p_client;
    when 'airtable' then update operator_clients set airtable_credential = p_credential where slug = p_client;
    when 'github' then update operator_clients set github_credential = p_credential where slug = p_client;
    else update operator_clients set vercel_credential = p_credential where slug = p_client;
  end case;
  perform operator_log('ceo', 'credential.linked', p_client, null, jsonb_build_object('platform', p_platform, 'linked', p_credential is not null));
end $$;

create or replace function operator_credential(p_client text, p_platform text)
returns table (id uuid, platform text, label text, secret_cipher bytea, secret_iv bytea, key_version int, url_allowlist text[])
language plpgsql security definer set search_path = public as $$
declare cid uuid; cr client_credentials;
begin
  perform vault_service_guard();
  select case p_platform when 'webflow' then webflow_credential when 'airtable' then airtable_credential
                         when 'github' then github_credential when 'vercel' then vercel_credential end into cid
    from operator_clients where slug = p_client;
  if cid is null then return; end if;
  select * into cr from client_credentials where client_credentials.id = cid;
  if cr.id is null or cr.status in ('revoked', 'check_needed') or cr.failed_login_count >= 2 then
    insert into credential_access_log (credential_id, agent_id, action, success, detail)
    values (cid, 'operator', 'api_call', false, jsonb_build_object('client', p_client, 'platform', p_platform, 'reason', coalesce(cr.status, 'missing')));
    return;
  end if;
  insert into credential_access_log (credential_id, agent_id, action, success, detail)
  values (cr.id, 'operator', 'api_call', true, jsonb_build_object('client', p_client, 'platform', p_platform));
  update client_credentials set last_used_at = now() where client_credentials.id = cr.id;
  return query select cr.id, cr.platform, cr.label, cr.secret_cipher, cr.secret_iv, cr.key_version, cr.url_allowlist;
end $$;

-- The client's Vercel team (id or slug) for team projects; null = the token's personal account.
create or replace function operator_set_vercel_team(p_client text, p_team text) returns void
language plpgsql security definer set search_path = public as $$
declare t text := nullif(btrim(coalesce(p_team, '')), '');
begin
  perform hq_guard();
  if t is not null and t !~ '^[A-Za-z0-9_-]{2,64}$' then raise exception 'the Vercel team is its id (team_…) or slug'; end if;
  update operator_clients set vercel_team = t where slug = p_client;
  if not found then raise exception 'unknown client %', p_client; end if;
  perform operator_log('ceo', 'vercel_team.set', p_client, null, jsonb_build_object('team', t));
end $$;

do $$
begin
  execute 'revoke execute on function operator_set_vercel_team(text,text) from public, anon';
  execute 'grant execute on function operator_set_vercel_team(text,text) to authenticated, service_role';
end $$;
