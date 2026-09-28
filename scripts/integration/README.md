# Integration test: worker + bot + dashboard against real PostgREST

`pnpm test:integration` runs the whole request lifecycle through the apps' **real Supabase client code**
(supabase-js → PostgREST → Postgres, with RLS, grants and JWT roles), without Docker or `supabase start`.

```
pnpm install
pnpm test:integration                 # ~20 s; exit 0 = pass (or skipped), 1 = failure
IT_DEBUG=1 pnpm test:integration      # PostgREST logs + worker logs
POSTGREST_VERSION=v13.0.7 pnpm test:integration
```

## What `run.mjs` sets up (and tears down)

1. **PostgreSQL**: the local server binaries (`PG_BIN`, `pg_config --bindir`, or `/usr/lib/postgresql/*/bin`).
   A throwaway cluster in a temp dir on a free port; when run as root it uses `runuser -u postgres`.
   No binaries → the suite is **skipped** (exit 0).
2. **Supabase-like roles** (`bootstrap.sql`): `authenticator` → `anon` / `authenticated` / `service_role`,
   `auth.users`, `auth.uid()/role()/jwt()` reading PostgREST's `request.jwt.claims` (Supabase's definitions),
   Supabase's default privileges on `public`. Then `supabase/migrations/*.sql`, `supabase/seed.sql`, `fixtures.sql`
   (CEO + non-CEO users, one client, one vaulted credential).
3. **PostgREST**: `POSTGREST_BIN`, `postgrest` on PATH, or the static Linux binary downloaded from GitHub releases
   (default `v12.2.12`, cached in `~/.cache/rizehubhq-integration`). Download impossible → **skipped** (exit 0).
   A tiny proxy serves it under `/rest/v1` like Supabase's gateway.
4. **JWTs** (HS256): anon key, service-role key, and access tokens for the CEO and a non-CEO user.
5. Runs `lifecycle.mts` with tsx, then stops everything and deletes the temp dir.

## What `lifecycle.mts` checks

Only three things are stand-ins: the model (`MockLanguageModelV2` via `apps/worker/src/testing.ts`), Telegram
(a recording `Sender`), and GoTrue (`auth.getUser()` answers from the minted JWT). Everything else is app code:

| App | Code under test | Client |
|---|---|---|
| dashboard | `app/actions.ts` (`createRequestAction`, `decideApprovalAction`), `lib/data/loaders.ts` (`loadHq`, `loadLiveSnapshot`), `lib/data/reports.ts`, `lib/data/vault.ts` | CEO / non-CEO JWT (RLS applies); `@/lib/supabase/server` is swapped for a session client |
| worker | `createSupabaseHqDb`, `WorkerLoop.tick()` → `planner` → `runner` (report_progress + submit_output tool calls) → `qa` (fails once, then passes), `runReportJob`, vault store (bytea round trip) | service role |
| bot | `createSupabaseBotDb`, `notifierTick` (approvals, dashboard-decision sync, reports), `onButton` / `onNoteText` (`decide_approval` via `telegram`), `/pause` | service role |

Lifecycle: dashboard creates request → COO plans → bot sends the plan → dashboard approves → copy task runs,
fails QA, is revised, passes → CEO approves in Telegram → dependent wireframe runs → CEO asks for changes in
Telegram → revised → dashboard approves → request `done`, all agents idle, `qa_reviews` / `activity_log` /
`agent_screens` written. Then reports, pause/resume, a planning failure, and security:
non-CEO and anon see and do nothing, the CEO cannot read `client_credentials.secret_cipher`, every
`SECURITY DEFINER` RPC reachable by anon/authenticated guards the caller, and every literal
`rpc('fn', { p_… })` call site in `apps/*` matches the live `pg_proc` signature.

Steps marked **⚠ KNOWN ISSUE** are documented bugs that print loudly but do not fail the run; when one starts
passing, the output says so and the `knownIssue` flag in `lifecycle.mts` should be removed.

## Environment knobs

`PG_BIN`, `POSTGREST_BIN`, `POSTGREST_VERSION`, `IT_CACHE_DIR`, `IT_DEBUG`.
