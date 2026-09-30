# syntax=docker/dockerfile:1.7
# RizeHub HQ brain service (docs/16-BRAIN.md): git mirror of the memory vault + indexer + internal Brain API.
# Build context = repo root:  docker build -f apps/brain/Dockerfile .
FROM node:22-slim

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 TZ=Asia/Manila COREPACK_HOME=/usr/local/share/corepack
# git + openssh-client: clone/pull the vault over SSH with the deploy key (mounted read-only at runtime, never baked in).
RUN export DEBIAN_FRONTEND=noninteractive && apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates tzdata \
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
COPY packages/shared/package.json packages/shared/
# Brain + its workspace deps only. Dev deps are kept on purpose: the service runs TypeScript through tsx.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "brain..."

COPY apps/brain apps/brain
COPY config config
# /data holds the vault clone (named volume brain-vault); owned by the unprivileged node user (uid 1000).
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production BRAIN_HTTP_PORT=4100 BRAIN_VAULT_DIR=/data/vault MODELS_FILE=/app/config/models.yaml
USER node
WORKDIR /app/apps/brain
# Internal only (dashboard on the default Docker network). Never publish this port.
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BRAIN_HTTP_PORT||4100)+'/livez').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
