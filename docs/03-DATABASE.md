# 03 · Database (Supabase)

Supabase is the contract between the dashboard, bot, and worker. Everything the office shows is a row here; everything an agent does is written here.

## Status models

**Request:** `staged → planning → plan_review → in_progress → awaiting_ceo → done`
(side exits: `rejected`, `cancelled`, `failed`)

**Task:** `pending → queued → working → qa_pending → qa_reviewing → awaiting_ceo → done`
- `pending` = waiting on dependencies · `queued` = ready to be claimed
- QA fail → `revision` → back to `queued` for the same agent (max `max_revisions`, then `failed` + escalate)
- side exits: `failed`, `cancelled`

**Agent (drives the office characters):** `idle · working · waiting · blocked · offline`
- `waiting` = has an item in your approval inbox · `blocked` = failed task / missing access
- `idle_activity` (coffee, lounge, water_cooler, stretch, chat) is chosen randomly while idle — see 07

**Approval:** `pending → approved | rejected | changes_requested`
Kinds: `plan` (COO's plan), `deliverable` (finished, QA-passed work), `external_action` (publish / send / merge / deploy).

## Migration: `init_schema.sql`

```sql
-- ========== ENUMS ==========
create type request_status  as enum ('staged','planning','plan_review','in_progress','awaiting_ceo','done','rejected','cancelled','failed');
create type task_status     as enum ('pending','queued','working','qa_pending','qa_reviewing','revision','awaiting_ceo','done','failed','cancelled');
create type agent_status    as enum ('idle','working','waiting','blocked','offline');
create type approval_status as enum ('pending','approved','rejected','changes_requested');
create type approval_kind   as enum ('plan','deliverable','external_action');

-- ========== CLIENTS ==========
create table clients (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,               -- 'madam-muse' → brain/clients/madam-muse/
  platforms   text[] not null default '{}',       -- {'shopify','github'}
  website     text,
  rizehub_account_id   text,                      -- set by the COO after onboarding
  rizehub_workspace_id text,
  service_package      text,                      -- e.g. seo-retainer, shopify-growth
  status      text not null default 'active',     -- active | paused | archived
  notes       text,
  created_at  timestamptz not null default now()
);

-- ========== AGENTS ==========
create table agents (
  id                 text primary key,             -- 'web-dev'
  name               text not null,                -- 'Web Developer'
  department         text not null,                -- leadership | growth | dev | design | content | qa
  model_role         text not null,              -- lead | dev | design | writer | sales | qa (see 14)
  runtime            text not null default 'worker', -- worker | hermes (added in 20260928080000)
  model_override     text,                       -- optional 'provider:model' for this agent only
  skills             text[] not null default '{}',
  status             agent_status not null default 'idle',
  current_task_id    uuid,
  idle_activity      text,                         -- coffee | lounge | water_cooler | stretch | chat
  idle_since         timestamptz default now(),
  avatar             jsonb not null default '{}',  -- {color, accessory, sprite_set}
  desk               jsonb not null default '{}',  -- {id} office desk slot, e.g. {"id":"dev-1"}
  max_parallel       int not null default 1,
  daily_budget_usd   numeric(10,2) not null default 3,
  enabled            boolean not null default true,
  updated_at         timestamptz not null default now()
);

-- ========== REQUESTS ==========
create table requests (
  id          uuid primary key default gen_random_uuid(),
  source      text not null check (source in ('telegram','dashboard','schedule','rizehub')),  -- rizehub = webhook-created
  raw_text    text not null,
  client_id   uuid references clients(id),
  title       text,
  brief       jsonb,                                -- structured brief written by COO
  priority    text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  due_date    date,
  status      request_status not null default 'staged',
  cost_usd    numeric(10,4) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ========== TASKS ==========
create table tasks (
  id                   uuid primary key default gen_random_uuid(),
  request_id           uuid not null references requests(id) on delete cascade,
  client_id            uuid references clients(id),
  agent_id             text not null references agents(id),
  title                text not null,
  instructions         text not null,
  work_type            text not null,               -- matches brain/sops + qa-checklists file names
  acceptance_criteria  jsonb not null default '[]', -- ["Mobile responsive", "Keyword in H1", …]
  depends_on           uuid[] not null default '{}',
  status               task_status not null default 'pending',
  revision_count       int not null default 0,
  max_revisions        int not null default 3,
  qa_feedback          jsonb,                        -- latest failed checks, fed back to the agent
  output               jsonb,                        -- {summary, files:[…], links:[…], branch, preview_url}
  claimed_at           timestamptz,
  started_at           timestamptz,
  completed_at         timestamptz,
  heartbeat_at         timestamptz,
  tokens_in            int not null default 0,
  tokens_out           int not null default 0,
  cost_usd             numeric(10,4) not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index on tasks (status, agent_id);
create index on tasks (request_id);

-- ========== QA REVIEWS ==========
create table qa_reviews (
  id               uuid primary key default gen_random_uuid(),
  task_id          uuid not null references tasks(id) on delete cascade,
  reviewer_id      text not null references agents(id),
  attempt          int not null,
  verdict          text not null check (verdict in ('pass','fail')),
  score            int check (score between 0 and 100),
  checks           jsonb not null,                   -- [{criterion, result:'pass'|'fail', note, evidence}]
  summary          text,
  evidence_urls    text[] not null default '{}',     -- screenshots, lighthouse reports
  created_at       timestamptz not null default now()
);

-- ========== APPROVALS ==========
create table approvals (
  id           uuid primary key default gen_random_uuid(),
  kind         approval_kind not null,
  request_id   uuid references requests(id) on delete cascade,
  task_id      uuid references tasks(id) on delete cascade,
  agent_id     text references agents(id),
  title        text not null,
  summary      text,
  payload      jsonb not null default '{}',          -- plan JSON, deliverable output, or action spec
  preview_url  text,
  status       approval_status not null default 'pending',
  ceo_note     text,
  decided_at   timestamptz,
  decided_via  text check (decided_via in ('dashboard','telegram')),
  telegram_message_id bigint,
  created_at   timestamptz not null default now()
);
create index on approvals (status);

-- ========== REPORTS ==========
create table reports (
  id           uuid primary key default gen_random_uuid(),
  agent_id     text references agents(id),          -- null for the CEO daily digest
  report_date  date not null,
  kind         text not null check (kind in ('standup','daily_digest','weekly')),
  done         jsonb not null default '[]',
  next         jsonb not null default '[]',
  blockers     jsonb not null default '[]',
  body_md      text,
  cost_usd     numeric(10,4) not null default 0,
  created_at   timestamptz not null default now(),
  unique (agent_id, report_date, kind)
);

-- ========== ACTIVITY LOG ==========
create table activity_log (
  id          bigserial primary key,
  actor       text not null,                         -- 'ceo' | agent id | 'system'
  action      text not null,                         -- 'request.created', 'task.claimed', 'tool.github.push'…
  request_id  uuid,
  task_id     uuid,
  client_id   uuid,
  detail      jsonb not null default '{}',
  cost_usd    numeric(10,4) not null default 0,
  created_at  timestamptz not null default now()
);
create index on activity_log (created_at desc);

-- ========== CONNECTIONS (metadata only — never the secret itself) ==========
create table connections (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid references clients(id) on delete cascade,
  platform     text not null check (platform in ('shopify','github','figma','webflow','wordpress','gmail','other')),
  label        text not null,
  secret_ref   text not null,                        -- env var name or vault key, e.g. SHOPIFY_TOKEN_MADAM_MUSE
  scopes       text[] not null default '{}',
  status       text not null default 'active' check (status in ('active','expiring','revoked','error')),
  expires_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);

-- ========== JOB OPPORTUNITIES (Sales Agent: job search) ==========
create table job_opportunities (
  id             uuid primary key default gen_random_uuid(),
  source         text not null,                     -- onlinejobs, indeed, linkedin, upwork, remote-board, pasted
  url            text not null unique,
  title          text not null,
  company        text,
  platform_tags  text[] not null default '{}',      -- shopify, webflow, wordpress…
  rate           text,
  posted_at      timestamptz,
  fit_score      int check (fit_score between 0 and 100),
  fit_reasons    jsonb not null default '[]',
  red_flags      jsonb not null default '[]',
  draft          text,                               -- tailored application
  status         text not null default 'found'
                 check (status in ('found','shortlisted','drafted','approved','applied','replied','interview','offer','rejected','skipped')),
  applied_at     timestamptz,
  follow_up_at   timestamptz,
  task_id        uuid references tasks(id),
  created_at     timestamptz not null default now()
);

-- ========== RIZEHUB LINKS (references only — RizeHub is the system of record) ==========
create table rizehub_refs (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid references tasks(id) on delete cascade,
  client_id    uuid references clients(id),
  kind         text not null check (kind in ('lead','lead_list','account','workspace','report','job')),
  rizehub_id   text not null,
  summary      jsonb not null default '{}',        -- small snapshot for the dashboard (name, score, preview_url)
  created_at   timestamptz not null default now()
);
create index on rizehub_refs (kind, rizehub_id);

-- ========== WEBHOOK INBOX (RizeHub → HQ) ==========
create table webhook_events (
  id           uuid primary key default gen_random_uuid(),
  event        text not null,                      -- job.completed, client.signed_up…
  payload      jsonb not null,
  signature_ok boolean not null,
  processed_at timestamptz,
  created_at   timestamptz not null default now()
);

-- ========== CLIENT VAULT (see 09) ==========
create table client_credentials (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references clients(id) on delete cascade,
  platform       text not null,                      -- shopify, webflow, wordpress, hosting, ftp, gmail, ga4, other
  label          text not null,                      -- 'Madam Muse Shopify collaborator'
  login_url      text,
  username       text,
  secret_type    text not null check (secret_type in ('password','api_token','app_password','ssh_key','other')),
  secret_cipher  bytea not null,                     -- AES-256-GCM ciphertext; key only in worker env
  secret_iv      bytea not null,
  key_version    int not null default 1,
  twofa_method   text not null default 'none' check (twofa_method in ('none','sms','email','app','collaborator')),
  scope_notes    text,                               -- shown to agents: what they may/may not do
  url_allowlist  text[] not null default '{}',       -- enforced by vault_login
  status         text not null default 'active' check (status in ('active','check_needed','expiring','revoked')),
  expires_at     timestamptz,
  last_used_at   timestamptz,
  created_by     text not null default 'ceo',        -- ceo | client_link
  created_at     timestamptz not null default now()
);

create table credential_grants (
  credential_id  uuid references client_credentials(id) on delete cascade,
  agent_id       text references agents(id),
  primary key (credential_id, agent_id)
);

create table credential_access_log (
  id             bigserial primary key,
  credential_id  uuid references client_credentials(id) on delete set null,
  agent_id       text,
  task_id        uuid,
  action         text not null,                      -- login | api_call | reveal | failed_login | rotate | revoke
  success        boolean not null,
  detail         jsonb not null default '{}',        -- never contains secrets
  created_at     timestamptz not null default now()
);

create table access_requests (                        -- secure one-time link for clients to submit logins
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  token_hash   text not null,
  platforms    text[] not null,
  expires_at   timestamptz not null,
  used_at      timestamptz
);

-- The dashboard (authenticated role) may read metadata but never the ciphertext.
-- Table-level SELECT must be revoked first, then re-granted on the safe columns only.
revoke select on client_credentials from authenticated, anon;
grant select (id, client_id, platform, label, login_url, username, secret_type, key_version,
              twofa_method, scope_notes, url_allowlist, status, expires_at, last_used_at, created_by, created_at)
  on client_credentials to authenticated;
-- Secrets are written only by the worker (service role) via its /vault/store endpoint.
revoke insert, update on client_credentials from authenticated, anon;

-- ========== AGENT CHAT (CEO ↔ agent) ==========
create table agent_messages (
  id          bigserial primary key,
  agent_id    text not null references agents(id),
  sender      text not null check (sender in ('ceo','agent')),
  body        text not null,
  task_id     uuid references tasks(id),
  became_request_id uuid references requests(id),   -- set when a chat instruction is turned into a request
  created_at  timestamptz not null default now()
);

-- ========== POV FEED (what each agent's screen shows; see 07) ==========
create table agent_screens (
  agent_id     text primary key references agents(id),
  task_id      uuid references tasks(id),
  app          text not null default 'idle',        -- editor | browser | doc | sheet | leads | inbox | review | idle
  title        text,                                -- e.g. 'sections/bundle-hero.liquid' or 'madammuse.co — preview'
  content      text,                                -- latest text snippet (code/draft), trimmed to ~4 KB
  image_url    text,                                -- latest screenshot (browser/QA), stored in Supabase Storage
  step_note    text,                                -- one-line 'what I'm doing now'
  progress     int check (progress between 0 and 100),
  updated_at   timestamptz not null default now()
);

-- ========== SETTINGS ==========
create table settings (
  key    text primary key,
  value  jsonb not null
);

-- ========== updated_at trigger ==========
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger t_requests_touch before update on requests for each row execute function touch_updated_at();
create trigger t_tasks_touch    before update on tasks    for each row execute function touch_updated_at();
create trigger t_agents_touch   before update on agents   for each row execute function touch_updated_at();
```

## Queue functions

```sql
-- Atomically claim the next ready task for any enabled, non-busy agent.
create or replace function claim_next_task() returns tasks
language plpgsql as $$
declare t tasks;
begin
  select tk.* into t
  from tasks tk
  join agents a on a.id = tk.agent_id and a.enabled
  where tk.status = 'queued'
    and (select count(*) from tasks w where w.agent_id = tk.agent_id and w.status = 'working') < a.max_parallel
  order by
    case (select priority from requests r where r.id = tk.request_id)
      when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    tk.created_at
  for update of tk skip locked
  limit 1;

  if t.id is null then return null; end if;

  update tasks set status = 'working', claimed_at = now(), heartbeat_at = now(),
                   started_at = coalesce(started_at, now())
  where id = t.id returning * into t;

  update agents set status = 'working', current_task_id = t.id, idle_activity = null
  where id = t.agent_id;

  return t;
end $$;

-- Move pending tasks to queued once all dependencies are done.
create or replace function release_ready_tasks(p_request uuid) returns int
language plpgsql as $$
declare n int;
begin
  update tasks tk set status = 'queued'
  where tk.request_id = p_request and tk.status = 'pending'
    and not exists (
      select 1 from tasks d where d.id = any(tk.depends_on) and d.status <> 'done'
    );
  get diagnostics n = row_count;
  return n;
end $$;

-- Re-queue tasks whose worker died (no heartbeat for 10 min).
create or replace function requeue_stale_tasks() returns int
language plpgsql as $$
declare n int;
begin
  update tasks set status = 'queued'
  where status = 'working' and heartbeat_at < now() - interval '10 minutes';
  get diagnostics n = row_count;
  return n;
end $$;
```

## Security (RLS)

Only **you** (the CEO login) can read/write from the browser. The worker and bot use the **service_role** key, which bypasses RLS; keep it server-side only.

```sql
-- ========== SECURITY: only the CEO account can use the dashboard ==========
create table ceo_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
-- After creating your login in Supabase Auth, run once:
--   insert into ceo_users (user_id) select id from auth.users where email = 'you@example.com';

create or replace function is_ceo() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from ceo_users where user_id = auth.uid());
$$;

alter table ceo_users enable row level security;
create policy ceo_self on ceo_users for select to authenticated using (user_id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array['clients','agents','requests','tasks','qa_reviews','approvals','reports','activity_log',
                           'connections','settings','job_opportunities','rizehub_refs','webhook_events',
                           'agent_messages','agent_screens','client_credentials','credential_grants',
                           'credential_access_log','access_requests']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy ceo_all on %I for all to authenticated using (is_ceo()) with check (is_ceo())', t);
  end loop;
end $$;
```

> The migration file `supabase/migrations/20260928000000_init_schema.sql` is the source of truth; `pnpm db:test` validates it (queue functions + RLS) in an in-memory Postgres.

## M12 · TOTP + auto-approve (`20260929000000_totp_auto_approve.sql`)

| Object | What |
|---|---|
| `is_ceo()` | now also requires `auth.jwt() ->> 'aal' = 'aal2'` once the CEO has a verified TOTP factor (`ceo_totp_enrolled()` reads `auth.mfa_factors`) |
| `ceo_totp_fresh(max_age)` · `ceo_step_up_guard()` | TOTP verified in the last N seconds (JWT `amr`); raises `step_up_required` unless the caller is a CEO with a fresh TOTP, a CEO without 2FA, or a direct DB session. Service role (Telegram) is refused once 2FA is on |
| `approval_is_high_risk(approvals)` | `kind = 'external_action'` and `payload.type = 'external_action'` (not Vault 2FA) |
| `decide_approval()` | approving a high-risk approval → `ceo_step_up_guard()`; `p_via = 'auto'` only for the plan `auto_approve_plan()` is deciding; auto decisions are logged with actor `system` |
| `approvals.decided_via` | + `'auto'`. Browser sessions lost `insert/update/delete` on `approvals` (RPCs only) |
| `plan_auto_approve_rules` | `id, name, enabled, max_cost_usd (0–100), max_tasks, work_types ⊆ auto_approve_internal_work_types(), client_scope any/none/listed, client_slugs`. CEO reads (RLS); writes via `save_auto_approve_rule(jsonb)` (turning on = step-up) / `delete_auto_approve_rule(uuid)` |
| `submit_plan()` | unchanged + calls `auto_approve_plan(approval)` at the end (hard guards `plan_auto_approve_blocker`, rules `plan_auto_approve_rule_miss`; audit: `payload.auto_approved`, activity `plan.auto_approved` / `plan.auto_approve_skipped`) |
| `settings.auto_approve_plans` | removed (superseded by the rules table; no rules = everything asks) |
| `ceo_step_up_status()` | `{enrolled, fresh, aal}` for the signed-in CEO |

Tests: `scripts/db-tests/110-totp-auto-approve.mjs` (stubs `auth.mfa_factors`). Details: docs/05 "[3]", docs/09 "Two-factor (TOTP)".

## Realtime

```sql
alter publication supabase_realtime add table agents, requests, tasks, approvals, qa_reviews, activity_log, reports, job_opportunities, rizehub_refs, agent_messages, agent_screens;
```
The dashboard subscribes to these — characters move, cards update, and the approval badge counts up live.

## Seed (`supabase/seed.sql`): agents roster (6 agents)

The team is six agents (`agents/roster.yaml`). Migration `20260928080000_six_agent_roster.sql` adds `agents.runtime`
(`worker` | `hermes`), creates the six rows, moves every row owned by the 20 retired agents to its new owner and deletes
them; the seed upserts the same rows. `desk` holds the office desk slot id.

```sql
insert into agents (id, name, department, model_role, runtime, skills, avatar, desk) values
('coo','COO','leadership','lead','worker','{planning,routing,prioritization,onboarding,client-reports,inbox,briefs}','{"color":"#6D4AFF","accessory":"tie"}','{"id":"board-head"}'),
('web-dev','Web Developer','dev','dev','hermes','{shopify,liquid,webflow,wordpress,nextjs,supabase,apis,automation}','{"color":"#5FBF4A","accessory":"headphones"}','{"id":"dev-1"}'),
('designer','Graphic Designer','design','design','hermes','{wireframes,ui,ux,figma,ad-creatives,social-graphics,brand-assets}','{"color":"#A259FF","accessory":"beret"}','{"id":"design-1"}'),
('writer','Content Writer','content','writer','hermes','{seo,blog,landing-copy,keywords,meta,captions,content-calendar,video-scripts}','{"color":"#22C55E","accessory":"glasses"}','{"id":"sales-1"}'),
('sales','Sales Agent','growth','sales','hermes','{lead-research,outreach,dm-replies,lead-qualification,proposals,follow-ups,job-search}','{"color":"#FFB020","accessory":"clipboard"}','{"id":"sales-2"}'),
('qa-lead','QA','qa','qa','worker','{testing,review,verification}','{"color":"#14B8A6","accessory":"magnifier-visor"}','{"id":"qa-1"}')
on conflict (id) do update set
  name = excluded.name, department = excluded.department, model_role = excluded.model_role, runtime = excluded.runtime,
  skills = excluded.skills, avatar = excluded.avatar, desk = excluded.desk;

insert into settings (key, value) values
('daily_budget_usd', '10'),
('digest_time', '"18:00"'),
('timezone', '"Asia/Manila"'),
('idle_activities', '["coffee","lounge_sofa","lobby","ping_pong","foosball","chat"]'),
('model_profile', '"free"'),
('monthly_budget_usd', '0');
```
(`model_role` values map to real models through `config/models.yaml`; see 14. Start on the free profile and upgrade individual roles only when QA keeps failing them.)
