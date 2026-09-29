# syntax=docker/dockerfile:1.7
# RizeHub HQ worker. Base = official Playwright image whose version MATCHES playwright-core in
# apps/worker/package.json (Chromium + system libs preinstalled at /ms-playwright). Bump both together.
# Build context = repo root:  docker build -f apps/worker/Dockerfile .
ARG PLAYWRIGHT_VERSION=1.56.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

ARG INSTALL_LIGHTHOUSE=false
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 TZ=Asia/Manila COREPACK_HOME=/usr/local/share/corepack
# git: github tool (branches/PRs) · ffmpeg/ffprobe: media QA probes · pnpm via corepack in a shared dir so the
# unprivileged agent uid can use it inside sandboxed workspaces. Lighthouse CLI is optional (QA falls back to the PageSpeed API).
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
# @anthropic-ai/claude-agent-sdk (Claude runtime, docs/05) ships Claude Code as a native binary in a per-platform optional
# package (~240 MB; linux-x64 = glibc, which this Ubuntu image has). pnpm 9's lockfile has no libc field, so the musl
# build may be installed too: it is never used here, so it is removed in the same layer.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "worker..." \
 && rm -rf node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*-musl@*

COPY packages/shared packages/shared
COPY apps/worker apps/worker
# Baked-in copies; docker-compose.yml bind-mounts ./agents, ./brain, ./config over them in production.
COPY agents agents
COPY brain brain
COPY config config
# Agent uid (docs/09 "Agent uid"): every agent command (bash_sandboxed, git/npm for agents) runs as AGENT_UID, never
# as the worker. The Playwright image already has pwuser = 1001 (reused); otherwise an "hqagent" user is created. No password,
# no sudo, no capabilities; HOME is the task workspace for every agent command.
ARG AGENT_UID=1001
ARG AGENT_GID=1001
RUN (getent group "${AGENT_GID}" >/dev/null || groupadd -g "${AGENT_GID}" hqagent) \
 && (getent passwd "${AGENT_UID}" >/dev/null || useradd -l -u "${AGENT_UID}" -g "${AGENT_GID}" -M -d /nonexistent -s /usr/sbin/nologin hqagent) \
 && mkdir -p /app/workspaces /pnpm \
 && chown root:root /app/workspaces && chmod 0755 /app/workspaces \
 && chown -R "${AGENT_UID}:${AGENT_GID}" /pnpm
# Each task jail (/app/workspaces/<task-id>) is created by the worker and chowned to AGENT_UID; the workspaces root
# stays root-owned so one task's commands cannot rename or replace another task's folder.

ENV NODE_ENV=production \
    AGENTS_DIR=/app/agents BRAIN_DIR=/app/brain WORKSPACES_DIR=/app/workspaces MODELS_FILE=/app/config/models.yaml \
    WORKER_HTTP_PORT=4000 AGENT_UID=${AGENT_UID} AGENT_GID=${AGENT_GID}
# Runs as ROOT inside the container on purpose: only root can start child processes under another uid (setuid), and
# a different uid is what keeps agent code away from the worker's secrets (/proc/<worker pid>/environ is readable
# only by the same uid or with CAP_SYS_PTRACE). docker-compose.yml drops every capability except CHOWN, DAC_OVERRIDE,
# FOWNER, SETUID, SETGID and KILL and sets no-new-privileges. Container root is still uid 0 on bind mounts, so files
# the worker writes into ./brain take brain/'s owner (tools/brainWrite.ts) and deploy/fix-perms.sh repairs ownership.
# hadolint ignore=DL3002
USER 0
WORKDIR /app/apps/worker
# Internal only (dashboard + RizeHub webhooks on the Docker networks). Never publish this port.
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HTTP_PORT||4000)+'/health',{headers:{'x-hq-secret':process.env.HQ_INTERNAL_SECRET||''}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# tsx directly (not `pnpm start`): no corepack download at runtime, clean SIGTERM handling.
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
