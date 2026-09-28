# RizeHub HQ · Dashboard

Next.js 15 (App Router) + React 19 + Tailwind v4. Spec: `docs/06-DASHBOARD-UI.md`.

## Modes

| Mode | When | Data | Actions |
|---|---|---|---|
| **LIVE** | `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set at **server start** | Supabase, as the signed-in user (RLS `is_ceo()`), kept live by Realtime | `create_request` / `decide_approval` RPCs only |
| **DEMO** | either var missing | `src/lib/mock.ts` | in memory (`src/lib/data/engine.ts` mirrors the RPC rules), a "Demo data" pill shows in the top bar |

Env is read at runtime (`src/lib/env.ts`), so one build serves both modes; the browser gets the public Supabase config from the server.

## Env vars

| Var | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | server (passed to browser) | Supabase API URL. Enables LIVE mode. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | server (passed to browser) | Public anon key. Enables LIVE mode. |
| `HQ_WORKER_URL` | server only | Worker base URL; agent Chat POSTs `{agentId, question}` to `${HQ_WORKER_URL}/chat`. |
| `HQ_INTERNAL_SECRET` | server only | Sent as `x-hq-secret` header to the worker. Never reaches the browser. |

The service-role key is **never** used by the dashboard. Chat reaches the worker only for a signed-in CEO in LIVE mode; otherwise the panel shows a demo reply built from the agent's live state. Expected worker response: `{ "answer": "..." }` (`reply`/`text` also accepted).

## Layout

- `src/lib/data/types.ts`: hand-written row types matching `supabase/migrations`.
- `src/lib/data/loaders.ts`: server loaders (agents, approvals, requests + tasks, activity, qa_reviews 7 d, clients).
- `src/lib/data/store.tsx`: client store + Realtime (`agents`, `agent_screens`, `approvals`, `tasks`, `requests`, `activity_log`, `qa_reviews`), optimistic actions, toasts. Falls back to 15 s polling if Realtime drops.
- `src/lib/data/derive.ts`: tile mapping, KPIs, activity text, request pipeline, kanban columns.
- `src/app/actions.ts`: server actions (`createRequestAction`, `decideApprovalAction`, `askAgentAction`, sign in/out).
- `src/middleware.ts`: redirects to `/login` without a session (LIVE only).

## Auth

Email + password via Supabase Auth, SSR cookies (`@supabase/ssr`). Only accounts in `ceo_users` see data; any other signed-in account gets a "This account isn't the CEO" screen with the SQL to add it.

### Two-factor (TODO)

docs/06 requires **TOTP 2FA**. Not built yet. Follow-up:

1. Enable MFA (TOTP) in Supabase Auth settings.
2. Add an enrol screen: `supabase.auth.mfa.enroll({ factorType: 'totp' })` → show the QR → `challengeAndVerify`.
3. In `signInAction` (`src/app/actions.ts`), after the password step, if the user has a verified factor, redirect to `/login?step=totp` and verify with `mfa.challenge` + `mfa.verify`.
4. In `src/middleware.ts`, require `mfa.getAuthenticatorAssuranceLevel().currentLevel === 'aal2'` for every page except `/login`.
5. Optionally enforce it in the database too: add `(auth.jwt() ->> 'aal') = 'aal2'` to `is_ceo()` in a new migration.

`TODO(2FA)` comments mark the exact spots in code.
