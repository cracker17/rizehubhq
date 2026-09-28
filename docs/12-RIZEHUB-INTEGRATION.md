# 12 · Connecting RizeHub HQ to RizeHub

RizeHub HQ is the AI team (dashboard + worker + bot). **RizeHub** is your product: the website, client accounts, workspaces, Lead Finder and report tools. They are separate apps that talk to each other over an API.

> Living on the same Hostinger VPS makes this fast and private, but it doesn't connect them by itself. RizeHub has to expose an **Agent API**, and HQ has to call it with a scoped key. This file defines that contract.

## The big picture

```
                    Hostinger VPS
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  ┌──────────────────────┐   private network   ┌──────────────┐ │
│  │  RizeHub HQ          │ ──────────────────► │  RizeHub app │ │
│  │  (worker, bot,       │  Agent API (HTTP)   │  (your code) │ │
│  │   dashboard)         │ ◄────────────────── │              │ │
│  └──────────┬───────────┘   webhooks          └──────┬───────┘ │
│             │                                        │         │
└─────────────┼────────────────────────────────────────┼─────────┘
              ▼                                        ▼
     HQ Supabase (tasks, approvals,          RizeHub database (clients,
     reports, activity log)                  workspaces, leads, reports)
```

**Who owns what (system of record):**

| Data | Lives in | HQ keeps |
|---|---|---|
| Clients, accounts, workspaces, billing | RizeHub | A reference (`rizehub_account_id`, `rizehub_workspace_id`) |
| Leads found by Lead Finder | RizeHub | Lead IDs attached to tasks + short summaries |
| Client reports (the actual report) | RizeHub | Report ID, preview link, QA verdict |
| Tasks, approvals, agent logs, costs, job opportunities | HQ | Everything |

Rule: **HQ never writes directly into RizeHub's database.** Every change goes through the Agent API, so RizeHub's own validation, permissions and audit log always apply.

## How they reach each other on one VPS

Both apps run in Docker on the same server. Put them on a **shared Docker network** so HQ calls RizeHub privately without going over the internet:

```yaml
# In both docker-compose files
networks:
  rizehub-internal:
    external: true        # create once: docker network create rizehub-internal
```
```
HQ worker  →  http://rizehub-app:8080/agent-api/v1/...   (internal, no public exposure)
RizeHub    →  http://hq-worker:4000/hooks/rizehub        (internal webhooks back to HQ)
```

- The Agent API is **not published to the internet**. Nginx does not route `/agent-api` publicly; only containers on `rizehub-internal` can reach it.
- If RizeHub later moves to a different server, switch to HTTPS + IP allowlist; the contract stays the same.
- RizeHub isn't in Docker yet? HQ can call `http://host.docker.internal:<port>` (add `extra_hosts: ["host.docker.internal:host-gateway"]`) and RizeHub binds that port to `127.0.0.1` only.

## Authentication & permissions

**Service keys, one per agent group** (not one master key):

| Key | Used by | Scopes |
|---|---|---|
| `RIZEHUB_KEY_LEADS` | Social Prospecting, Pipeline Desk | `leads:search`, `leads:read`, `leads:write_notes`, `lists:write` |
| `RIZEHUB_KEY_ONBOARDING` | Client Success | `accounts:create`, `workspaces:create`, `workspaces:configure`, `invites:draft` |
| `RIZEHUB_KEY_REPORTS` | EA & Report Desk, SEO, Social | `reports:generate`, `reports:read`, `metrics:read` |
| `RIZEHUB_KEY_READONLY` | QA Lead, COO | `*:read` |

- Keys are stored hashed in RizeHub (like passwords), with scopes, an owner label and `last_used_at`.
- Every request also sends `X-HQ-Task-Id` and `X-HQ-Agent-Id`, so RizeHub's audit log shows **which AI employee did what, for which task**.
- Revoking one key disables one agent group without touching the rest.
- Optional hardening: sign each request with HMAC (`X-Signature: sha256(body + timestamp)`) and reject requests older than 5 minutes.

**Client data access:** agents act *on behalf of RizeHub the agency*, never as a logged-in client. RizeHub enforces that a key can only touch clients the agency manages.

## The Agent API (what RizeHub must expose)

Plain HTTP + JSON, versioned under `/agent-api/v1`. Build it in whatever RizeHub already uses (Laravel, Node, etc.). HQ's worker wraps each endpoint as a tool.

### Conventions
- `Idempotency-Key` header on every write (HQ sends the task ID + step). Repeating the call returns the first result instead of creating a duplicate account or report.
- `?dry_run=true` on every write: validates and returns what *would* happen, changes nothing. HQ uses this to build the approval preview you see.
- Long jobs (lead searches, report generation) return `202 Accepted` + `job_id`; RizeHub calls HQ's webhook when done (or HQ polls `GET /jobs/{id}`).
- Errors: `{ "error": { "code": "workspace_exists", "message": "...", "retryable": false } }`.
- Rate limits returned in headers; the worker backs off automatically.

### Lead Finder
| Method & path | Purpose | Approval? |
|---|---|---|
| `POST /leads/search` | Run a Lead Finder search (`industry`, `location`, `platform` e.g. Shopify/Webflow/WordPress, `signals` e.g. slow site / no SSL / hiring, `limit`) → `job_id` | No (internal) |
| `GET /jobs/{job_id}` | Job status + result lead IDs | No |
| `GET /leads/{id}` | Lead details: company, website, platform, contact (business contact only), signals, score | No |
| `POST /leads/{id}/notes` | Agent research notes, fit score, recommended angle | No |
| `POST /lists` / `POST /lists/{id}/leads` | Save leads into a named list/campaign | No |
| `PATCH /leads/{id}` | Change stage (new → researched → contacted → replied → won/lost) | Stage changes to "contacted" only after you approved and sent the outreach |

### Accounts & workspaces (client onboarding)
| Method & path | Purpose | Approval? |
|---|---|---|
| `POST /accounts` | Create a client account (company, primary contact, plan) | **Yes** (external: creates a real account) |
| `POST /accounts/{id}/workspaces` | Create workspace from a template (`shopify-growth`, `seo-retainer`, `webflow-build`…) | **Yes** (bundled with account approval) |
| `PUT /workspaces/{id}/config` | Settings: connected site URL, report schedule, services enabled, branding | Covered by the onboarding approval |
| `POST /workspaces/{id}/projects` | Create starter projects/tasks inside the workspace | Covered |
| `POST /accounts/{id}/invites?send=false` | Prepare the client invite (not sent) | Sending = **Yes**, separate approval |
| `POST /invites/{id}/send` | Actually send the invite email | Executed by worker only after approval |
| `GET /accounts/{id}` / `GET /workspaces/{id}` | Read back for QA verification | No |

### Report tools
| Method & path | Purpose | Approval? |
|---|---|---|
| `GET /workspaces/{id}/metrics?from&to` | Raw numbers the report is built from | No |
| `POST /workspaces/{id}/reports` | Generate a report (`type`: seo-monthly, site-audit, ads-performance, lead-report; `period`) → `job_id` | No (draft) |
| `GET /reports/{id}` | Report data + `preview_url` (private link) + PDF link | No |
| `POST /reports/{id}/notes` | Agent-written summary / insights / next steps inserted into the report | No |
| `POST /reports/{id}/publish` | Make visible to the client and/or email it | **Yes** |

### Webhooks (RizeHub → HQ)
| Event | HQ reaction |
|---|---|
| `job.completed` / `job.failed` | Resume the waiting agent task |
| `account.created`, `workspace.ready` | Onboarding workflow continues |
| `client.signed_up` / `payment.received` | Creates an HQ request automatically: "Onboard {client}" (source=`rizehub`) |
| `lead.replied` (if RizeHub tracks inbox) | Pipeline Desk drafts a follow-up |
| `report.viewed` | Logged; appears in client activity |

Webhook requests are signed (`X-RizeHub-Signature`) and HQ rejects unsigned ones.

## How agents use it (HQ side)

Each endpoint group becomes a worker tool, only given to the roles that need it (see 04):

```ts
// apps/worker/src/tools/rizehub.ts (sketch)
export const rizehubTools = {
  leads_search:        { key: 'LEADS',      method: 'POST', path: '/leads/search',          external: false },
  lead_get:            { key: 'LEADS',      method: 'GET',  path: '/leads/:id',             external: false },
  lead_add_notes:      { key: 'LEADS',      method: 'POST', path: '/leads/:id/notes',       external: false },
  account_create:      { key: 'ONBOARDING', method: 'POST', path: '/accounts',              external: true  },
  workspace_create:    { key: 'ONBOARDING', method: 'POST', path: '/accounts/:id/workspaces', external: true },
  report_generate:     { key: 'REPORTS',    method: 'POST', path: '/workspaces/:id/reports', external: false },
  report_publish:      { key: 'REPORTS',    method: 'POST', path: '/reports/:id/publish',   external: true  },
};
// external: true  → the tool does a dry_run, creates an external_action approval with the preview,
//                   and the worker executes the real call only after you approve.
```

The keys live only in the worker's `.env`; the agent sees tool names and results, never keys.

## Testing safely

1. **RizeHub staging** — a copy of RizeHub on a different port/subdomain with its own database. HQ's local setup points at staging, never production.
2. **Test mode flag** — accounts/workspaces created with `test: true` are hidden from real dashboards and auto-deleted after 7 days.
3. **Contract tests** — HQ keeps a small test suite that calls each endpoint in `dry_run` mode against staging; run it before each deploy of either app.

## What you need to build in RizeHub (checklist)

- [ ] `agent_api_keys` table (hashed key, label, scopes, revoked_at, last_used_at)
- [ ] Middleware: key auth, scope check, `X-HQ-*` headers into the audit log, rate limit
- [ ] `/agent-api/v1` routes above, starting with Lead Finder + reports (read-mostly, lowest risk)
- [ ] `dry_run` and `Idempotency-Key` support on writes
- [ ] Job queue for long operations + `job.completed` webhook
- [ ] Workspace templates (JSON definitions of services, projects, report schedule)
- [ ] `test: true` accounts + cleanup job
- [ ] Staging instance

Build order: **Lead Finder read → reports → onboarding writes**. Each step is useful on its own.
