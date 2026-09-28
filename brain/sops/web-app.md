# SOP: web-app

Owner: web-dev. Output: a feature or app increment (Next.js App Router + Supabase by default) delivered as a small, tested PR on `agent/<task-id>`, with preview link. Never merged or deployed by the agent.

## Inputs to confirm
Repo, user story + acceptance criteria, design (Figma/mockup), data involved (and whether it's personal data), auth/roles, environments (dev Supabase project, Vercel preview). Missing design states, roles or data rules → `ask_ceo`. New paid service or architecture change → `ask_ceo` before building.

## Steps
1. Clone into `workspaces/<task-id>`, branch `agent/<task-id>`. `pnpm install`; run existing `typecheck`, `lint`, `test` to confirm a green baseline (note pre-existing failures, don't fix unrelated ones).
2. Read conventions: folder structure, existing components/UI kit (shadcn/ui?), data-access layer, auth helper, error handling, env schema. Follow them.
3. **Plan in the PR description:** routes/components, server vs client components, data model changes, RLS policies, env var names, test plan, rollback.
4. **Data layer** (if schema changes):
   - `supabase migration new <name>`; never edit applied migrations.
   - Tables: `id uuid default gen_random_uuid()`, `created_at timestamptz default now()`, FK with `on delete` behaviour chosen deliberately, indexes on FKs and filtered columns.
   - `alter table … enable row level security;` + explicit policies per operation and role using `(select auth.uid())`. Test as `anon`, owner, and non-owner.
   - Functions: `security invoker` by default; `security definer` only with `set search_path = ''` and schema-qualified names.
   - Regenerate types (`supabase gen types` / repo script).
5. **Server logic:** Server Components fetch data; mutations via Server Actions or route handlers that (a) authenticate, (b) authorise, (c) zod-validate, (d) return typed results/errors. Never trust client-provided IDs for ownership.
6. **UI:** client components only where needed; accessible forms (labels, errors linked with `aria-describedby`, focus management), loading/empty/error states, mobile-first at 375 px; no layout shift.
7. **Config:** new env vars added to the env schema and `.env.example` (names only). Server-only secrets never `NEXT_PUBLIC_`.
8. **Tests:** Vitest for pure logic and validators (happy path + ≥2 edge/failure cases); Playwright for the critical user flow; RLS test (SQL or integration) for new policies.
9. Run `pnpm typecheck && pnpm lint && pnpm test` (+ `pnpm build` if cheap). All green. Lighthouse on the changed page if UI-heavy.
10. Commit in logical steps; push; open PR (template below). The Git integration may create a preview deployment; that's fine. Production deploy/merge = CEO.
11. `submit_output`: PR link, preview URL, screenshots (375/1440), migrations, env var names, test output, criteria map, known limitations.

## PR template
```
## What
## Why (task <task-id>)
## How — key files
## Data — migrations, RLS policies
## Env — new variable names (values set by CEO)
## Tests — commands + results
## Screenshots
## Rollback — revert PR; down-migration notes
```
