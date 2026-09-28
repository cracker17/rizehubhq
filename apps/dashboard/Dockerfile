# syntax=docker/dockerfile:1.7
# RizeHub HQ dashboard: Next.js 15 standalone build of a pnpm workspace app.
# Build context = repo root:  docker build -f apps/dashboard/Dockerfile .
# NEXT_PUBLIC_* and all secrets are read at RUNTIME (apps/dashboard/src/lib/env.ts), so nothing is baked in.
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 CI=1
RUN apk add --no-cache libc6-compat && corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

# 1) Download every package in the lockfile into the pnpm store (cached layer: only the lockfile invalidates it).
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
# All workspace manifests, so the frozen lockfile matches the workspace exactly.
COPY package.json ./
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/worker/package.json apps/worker/
COPY apps/bot/package.json apps/bot/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "dashboard..."

# 2) Build. outputFileTracingRoot = repo root, so the server lands at .next/standalone/apps/dashboard/server.js.
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/dashboard apps/dashboard
COPY agents agents
RUN pnpm --filter dashboard build

# 3) Runtime: only the traced standalone output.
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 AGENTS_DIR=/app/agents
COPY --from=build --chown=node:node /repo/apps/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build --chown=node:node /repo/apps/dashboard/public ./apps/dashboard/public
# Role files for the Agents page (compose also bind-mounts ./agents here read-only so edits show without a rebuild).
COPY --chown=node:node agents ./agents
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/dashboard/server.js"]
