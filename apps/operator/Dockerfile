# syntax=docker/dockerfile:1.7
# RizeHub HQ Operator (docs/17-OPERATOR.md): watches client chats in the workspace browsers over CDP, drafts with Claude.
# No browser in this image: the browsers live in the workspace containers (deploy/workspace); playwright-core only attaches.
# glibc base on purpose: @anthropic-ai/claude-agent-sdk ships Claude Code as a native linux-x64 (glibc) binary.
# Build context = repo root:  docker build -f apps/operator/Dockerfile .
FROM node:22-slim

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 TZ=Asia/Manila COREPACK_HOME=/usr/local/share/corepack
RUN export DEBIAN_FRONTEND=noninteractive && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY package.json ./
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/worker/package.json apps/worker/
COPY apps/bot/package.json apps/bot/
COPY apps/brain/package.json apps/brain/
COPY apps/operator/package.json apps/operator/
COPY packages/shared/package.json packages/shared/
# Operator + its workspace deps (incl. the worker package, whose settings / model / budget helpers it reuses). Dev deps
# kept: it runs TypeScript through tsx. The musl build of Claude Code is never used on this glibc image.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "operator..." \
 && rm -rf node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*-musl@*

COPY packages/shared packages/shared
COPY apps/worker apps/worker
COPY apps/operator apps/operator
COPY config config

ENV NODE_ENV=production MODELS_FILE=/app/config/models.yaml
# Unprivileged (uid 1000): it only talks to Supabase, the Anthropic API and the workspace browsers.
USER node
WORKDIR /app/apps/operator
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
