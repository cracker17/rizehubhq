# syntax=docker/dockerfile:1.7
# RizeHub HQ worker. Base = official Playwright image whose version MATCHES playwright-core in
# apps/worker/package.json (Chromium + system libs preinstalled at /ms-playwright). Bump both together.
# Build context = repo root:  docker build -f apps/worker/Dockerfile .
ARG PLAYWRIGHT_VERSION=1.56.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

ARG INSTALL_LIGHTHOUSE=false
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 TZ=Asia/Manila COREPACK_HOME=/usr/local/share/corepack
# git: github tool (branches/PRs) · ffmpeg/ffprobe: media QA probes · pnpm via corepack in a shared dir so the
# non-root runtime user can use it inside sandboxed workspaces. Lighthouse CLI is optional (QA falls back to the PageSpeed API).
RUN export DEBIAN_FRONTEND=noninteractive && apt-get update \
 && apt-get install -y --no-install-recommends git ffmpeg ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@9.15.0 --activate && chmod -R a+rX /usr/local/share/corepack \
 && if [ "$INSTALL_LIGHTHOUSE" = "true" ]; then npm install -g lighthouse@12 && npm cache clean --force; fi
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY package.json ./
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/worker/package.json apps/worker/
COPY apps/bot/package.json apps/bot/
COPY packages/shared/package.json packages/shared/
# Worker + its workspace deps only. Dev deps are kept on purpose: the worker runs TypeScript through tsx.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "worker..."

COPY packages/shared packages/shared
COPY apps/worker apps/worker
# Baked-in copies; docker-compose.yml bind-mounts ./agents, ./brain, ./config over them in production.
COPY agents agents
COPY brain brain
COPY config config
# workspaces volume + a pnpm home the sandboxed dev tools can write to at runtime
RUN mkdir -p /app/workspaces /pnpm && chown -R pwuser:pwuser /app/workspaces /pnpm

ENV NODE_ENV=production \
    AGENTS_DIR=/app/agents BRAIN_DIR=/app/brain WORKSPACES_DIR=/app/workspaces MODELS_FILE=/app/config/models.yaml \
    WORKER_HTTP_PORT=4000
USER pwuser
WORKDIR /app/apps/worker
# Internal only (dashboard + RizeHub webhooks on the Docker networks). Never publish this port.
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HTTP_PORT||4000)+'/health',{headers:{'x-hq-secret':process.env.HQ_INTERNAL_SECRET||''}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# tsx directly (not `pnpm start`): no corepack download at runtime, clean SIGTERM handling.
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
