# 16 · HQ Brain (M14)

One shared long-term memory for Julev, every Claude account/device and the HQ agents. The **memory vault** (markdown in the
private repo `cracker17/claude-memory-vault`) is the source of truth; HQ keeps a third live copy on the VPS and a
searchable index in Supabase that is rebuildable from git at any time. The full product plan (MCP connector, animated
`/brain` UI, agents on the brain) lives in the vault: `projects/rizehub-hq/brain-plan.md`.

> Not the same thing as the repo's `brain/` folder (playbooks, SOPs, QA checklists the agents read today through
> `apps/worker/src/brain.ts`). That stays as is; folding it into the vault is an M14.4 item.

## Milestones

| # | What | Status |
|---|---|---|
| M14.1 | VPS mirror + brain service + indexer (keyword + pgvector) + read-only Brain API + GitHub webhook | built |
| M14.2 | Brain MCP connector at `https://hq.rizehub.ph/mcp/brain` (OAuth via HQ login + 2FA), write path (commit + push) | next |
| M14.3 | Brain UI v1 at `/brain` (Core, Ctrl+K, project view, New Project wizard, activity) | |
| M14.4 | Agents on the brain (scoped tokens, auto-load per client, proposals, digest), fold `brain/` in | |
| M14.5 | Polish: graph, Ask the Brain, diff/revert, PWA, voice; nightly R2 backup | |

## Architecture (M14.1)

```
PC vault ──sync 15 min──► GitHub (private) ──push webhook──► hq.rizehub.ph/api/brain/github (dashboard, public)
                                   ▲                                     │ raw body + GitHub headers only
                                   │ git fetch (deploy key, pinned       ▼
                                   │ host key)                  hq-brain :4100 (default network only)
                                   └───────────────── /data/vault ◄─ pull → index → Supabase brain_* tables
                                                                    ▲
                                          dashboard (lib/brainCall.ts, x-brain-secret) — M14.3 UI
```

- **Container `hq-brain`** (`apps/brain`): Node 22 + tsx, plain `node:http`. Read-only root filesystem, no capabilities,
  unprivileged user (uid 1000). Only on the compose `default` network: the worker (which runs agent code) and the
  Hermes containers can't read its deploy key or OpenAI key, and the split env files never give them `BRAIN_*` secrets.
- **Sync**: webhook (HMAC-SHA256, `push` to `main` only) → debounced pull; plus a poll every `BRAIN_POLL_SECONDS`
  (default 300) in case a webhook is missed. Runs are serialised. M14.1 never writes to the clone: it fast-forwards,
  or resets to `origin/main` if upstream history was rewritten (logged as an event).
- **Index** (`supabase/migrations/20260930010000_brain_index.sql`): every `.md` file's sha256 is compared with the
  manifest, so only changed files are re-chunked; a chunk keeps its embedding when its text (title + heading + text)
  is unchanged. Heading-aware chunks (~1,200 chars, 150 overlap). `memory.md` sections become rows: Status, Links,
  Decisions log (`- YYYY-MM-DD: …`), Open next steps (`- [x] …`).
- **Secrets never get in**: files matching the vault's own `sync.ps1` patterns (`apps/brain/src/secretScan.ts`) are not
  indexed and show up as `blocked_secret` events (path only). Files over 512 KB are skipped.
- **Search** `brain_search`: keyword (all terms first, then most distinct terms, then frequency) and cosine similarity
  (≥ 0.2) fused by reciprocal rank; at most 2 chunks per document. No embeddings key → keyword-only, `/health` says so.
- **Embeddings**: `config/models.yaml` `embeddings:` (default `openai:text-embedding-3-small`, 1536 dims) with the
  brain's own `BRAIN_OPENAI_API_KEY` (give it its own spend limit). A model change clears and re-embeds everything.

## Tables & functions

`brain_projects`, `brain_documents`, `brain_chunks` (tsvector + `vector(1536)`, GIN + HNSW), `brain_decisions`,
`brain_next_steps`, `brain_events`, `brain_sync_state`. RLS: the CEO reads (`is_ceo()`), nobody but the service role writes.
Service-only functions: `brain_sync_projects`, `brain_document_manifest`, `brain_upsert_document`, `brain_replace_chunks`,
`brain_delete_documents`, `brain_refresh_projects`, `brain_chunks_missing_embedding`, `brain_set_embeddings`,
`brain_clear_embeddings`, `brain_reset_index`, `brain_log_event`, `brain_set_sync_state`. CEO API (+ service):
`brain_health`, `brain_list_projects`, `brain_project_bundle`, `brain_get_document`, `brain_search`, `brain_recent_events`.
Every function returns one scalar/jsonb value so supabase-js `rpc()` and the local PGlite store behave the same.

> PGlite gotcha: pgvector values handled inside **plpgsql** crash PGlite's wasm build (`table index is out of bounds`) or
> silently return nothing. Functions that touch vectors are `language sql` (`brain_replace_chunks`, `brain_set_embeddings`,
> `brain_search`). Real Postgres is fine either way.

## Brain API (internal, header `x-brain-secret`)

| Route | Returns |
|---|---|
| `GET /livez` | `{ok:true}`, no secret, no data (Docker HEALTHCHECK; a failing sync must not roll back the stack) |
| `GET /health` | head sha, last pull/index/webhook, projects/documents/chunks/embedded, keyword-only flag, last run report |
| `GET /projects` | projects with last activity, sessions and open next steps |
| `GET /projects/:slug?sessions=2` | the `/load` bundle: project, memory.md, newest sessions, decisions, next steps, documents |
| `GET /documents?path=` | one document |
| `GET /search?q=&project=&kind=a,b&k=10` | hybrid hits with path, heading, text, score, `via` |
| `GET /activity?n=50` | newest events |
| `POST /reindex[?full=1]` | pull + index now (`full=1` drops the index first) |
| `POST /hooks/github` | GitHub webhook (own HMAC check), reached through the dashboard's `/api/brain/github` |

## Env (`.env` → `.env.brain` via `scripts/split-env.mjs`)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BRAIN_INTERNAL_SECRET` (also dashboard), `BRAIN_WEBHOOK_SECRET`,
`BRAIN_REPO_URL`, `BRAIN_OPENAI_API_KEY`; optional `BRAIN_REPO_BRANCH`, `BRAIN_POLL_SECONDS`, `BRAIN_EMBED_MODEL`,
`BRAIN_HTTP_PORT`. Set by the image/compose: `BRAIN_VAULT_DIR`, `BRAIN_DEPLOY_KEY_PATH`, `BRAIN_KNOWN_HOSTS_PATH`,
`MODELS_FILE`; dashboard `BRAIN_URL`. None are required by `check-env`, so an unconfigured brain never blocks an HQ deploy.

## Local run (no Docker, no Supabase)

```
pnpm dev:brain                              # clones ../../claude-memory-vault (or BRAIN_REPO_URL) into a temp dir,
                                            # runs the real migrations in PGlite + pgvector, API on :4100
BRAIN_FAKE_EMBEDDINGS=1 pnpm dev:brain      # exercise the vector path with deterministic fake embeddings
curl -H "x-brain-secret: dev-brain-secret" "localhost:4100/search?q=deploy%20key"
```
A real OpenAI key for local runs goes in `apps/brain/.env.local` (gitignored). Tests: `pnpm --filter brain test`
(unit + an end-to-end run against a temp git repo), `pnpm db:test` (`scripts/db-tests/200-brain.mjs`).

## Deploy (once)

1. Apply the migration to the HQ Supabase project **before** pushing to `main` (auto-deploy rule).
2. `sudo -u rizehq -H bash deploy/brain-setup.sh`: deploy key + pinned GitHub host key + `BRAIN_*` secrets in `.env`.
3. Add the printed public key as a **deploy key with write access** on `cracker17/claude-memory-vault`.
4. Optional: `BRAIN_OPENAI_API_KEY=` in `.env`. Then push / `deploy/update.sh --force`.
5. Vault repo webhook: `https://hq.rizehub.ph/api/brain/github`, `application/json`, secret = `BRAIN_WEBHOOK_SECRET`, push only.
6. Check: `docker exec hq-brain node -e "fetch('http://127.0.0.1:4100/health',{headers:{'x-brain-secret':process.env.BRAIN_INTERNAL_SECRET}}).then(r=>r.json()).then(console.log)"`.

Recovery: the index is disposable (`POST /reindex?full=1`), the clone is disposable (`docker volume rm rizehubhq_brain-vault`),
GitHub and the PC hold the history.
