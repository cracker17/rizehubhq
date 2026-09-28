# CLAUDE.md — RizeHub HQ

You are helping build **RizeHub HQ**: a 6-agent AI team (COO, Web Developer, Graphic Designer, Content Writer, Sales Agent, QA; see `agents/roster.yaml`) commanded via Telegram and a dashboard, with a CEO approval gate on everything external. The full spec lives in `docs/` (files 00–14). HQ connects to the existing **RizeHub** app only through its Agent API (`docs/12-RIZEHUB-INTEGRATION.md`); workflows are in `docs/13-WORKFLOWS.md`. Read the relevant spec file before working on any part.

## Stack
- pnpm monorepo: `apps/dashboard` (Next.js App Router, TS, Tailwind, shadcn/ui), `apps/worker` (Node TS, Vercel AI SDK with a provider-agnostic model router), `apps/bot` (grammY), `packages/shared` (types, zod schemas, enums).
- Supabase (local via `supabase start`; migrations in `supabase/migrations`).
- Agents: `agents/*.md` role files + `agents/roster.yaml`. Knowledge: `brain/`.

## Rules
1. Build milestone by milestone per `docs/11-ROADMAP.md`. Don't start the next milestone until the current acceptance criteria pass.
2. Supabase is the only contract between apps. Dashboard and bot never call agents directly.
3. Status enums in `packages/shared/src/status.ts` must mirror the DB enums exactly.
4. Any tool that changes the outside world (publish, send, merge, deploy, spend) must create an `external_action` approval — never execute directly.
5. Never put secrets in client code, prompts, logs, workspaces, or git. Service-role key is server-only.
6. After schema changes: new migration file (never edit applied ones) → `pnpm db:types`.
7. UI must match `docs/06-DASHBOARD-UI.md` tokens and mockup A; mobile-first down to 375px.
8. Never hard-code a model or provider in agent code; always go through `pickModel(role)` and `config/models.yaml` (docs/14). Verify AI SDK APIs against current docs before using them.
9. Never call RizeHub's database directly and never use production RizeHub keys locally; use the mock or staging.
10. Keep functions small, typed, and tested where logic is non-trivial (queue claiming, dependency release, QA verdict handling).

## Commands
- `supabase start` / `supabase db reset` / `pnpm db:types`
- `pnpm dev` (all apps) · `pnpm dev:dashboard` · `pnpm dev:worker` · `pnpm dev:bot`
