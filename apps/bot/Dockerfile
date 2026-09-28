# syntax=docker/dockerfile:1.7
# RizeHub HQ Telegram bot (grammY, long polling: no inbound port).
# Build context = repo root:  docker build -f apps/bot/Dockerfile .
FROM node:22-alpine
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 TZ=Asia/Manila
RUN apk add --no-cache tzdata && corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY package.json ./
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/worker/package.json apps/worker/
COPY apps/bot/package.json apps/bot/
COPY packages/shared/package.json packages/shared/
# Dev deps kept: the bot runs TypeScript through tsx.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "bot..."

COPY packages/shared packages/shared
COPY apps/bot apps/bot

ENV NODE_ENV=production
USER node
WORKDIR /app/apps/bot
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
