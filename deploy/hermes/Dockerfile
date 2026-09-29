# syntax=docker/dockerfile:1.7
# Hermes Agent image for RizeHub HQ: one container per agent (web-dev, designer, writer, sales), each with its own
# HERMES_HOME volume. Only the Hermes API server runs (`hermes gateway` with API_SERVER_ENABLED=true); no messaging
# platforms, local terminal backend inside this locked-down container (no Docker socket). See deploy/hermes/README.md.
# Build context = deploy/hermes:  docker build -t rizehubhq-hermes deploy/hermes
FROM debian:bookworm-slim

# ---------------------------------------------------------------------------------------------------------------
# INSTALL: the documented one-liner (docs: getting-started/installation) is `curl -fsSL <url>/install.sh | bash`;
# no pip/uv package or official image is published. install.sh (read from github.com/NousResearch/hermes-agent,
# scripts/install.sh) clones the repo into --dir (default $HERMES_HOME/hermes-agent), bootstraps uv + Python into
# $HERMES_RUNTIME_DIR (default $HERMES_HOME/tools), runs `pm install` (--skip-browser / --skip-computer-use drop
# agent-browser + Chromium and cua-driver), publishes the `hermes` launcher to ~/.local/bin, and skips the interactive
# setup/gateway stages with --non-interactive. We install code + runtime under /opt/hermes so the per-agent
# HERMES_HOME volume (/data/hermes) only holds data. NOT build-tested here (no Docker daemon in the dev sandbox):
# check the first build. Pin a version with --build-arg HERMES_INSTALL_ARGS="... --commit <sha>".
# ---------------------------------------------------------------------------------------------------------------
ARG HERMES_INSTALL_URL=https://hermes-agent.nousresearch.com/install.sh
ARG HERMES_INSTALL_ARGS="--non-interactive --skip-browser --skip-computer-use --dir /opt/hermes/hermes-agent"

RUN export DEBIAN_FRONTEND=noninteractive && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git bash tzdata xz-utils libstdc++6 libatomic1 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --shell /bin/bash hermes \
 && mkdir -p /opt/hermes /data/hermes /workspace /etc/hermes-hq \
 && chown hermes:hermes /opt/hermes /data/hermes /workspace

USER hermes
WORKDIR /home/hermes
ENV HOME=/home/hermes \
    HERMES_RUNTIME_DIR=/opt/hermes/tools \
    PATH=/home/hermes/.local/bin:/opt/hermes/hermes-agent/.hermes/bin:$PATH \
    TZ=Asia/Manila
# Build-time HERMES_HOME is a throwaway (install.sh writes a default config/.env there); runtime uses /data/hermes.
RUN curl -fsSL "$HERMES_INSTALL_URL" -o /tmp/hermes-install.sh \
 && HERMES_HOME=/opt/hermes/build-home bash /tmp/hermes-install.sh $HERMES_INSTALL_ARGS \
 && rm -rf /tmp/hermes-install.sh /opt/hermes/build-home \
 && (command -v hermes >/dev/null || { echo "hermes is not on PATH after install.sh: fix PATH / HERMES_INSTALL_ARGS in deploy/hermes/Dockerfile" >&2; exit 1; })

COPY --chown=root:root --chmod=0755 entrypoint.sh /usr/local/bin/hq-hermes-entrypoint
# Runtime: data (memory, skills, sessions, rendered config.yaml + .env) lives in the per-agent volume.
ENV HERMES_HOME=/data/hermes \
    XDG_CACHE_HOME=/tmp/cache
WORKDIR /workspace
EXPOSE 8642
ENTRYPOINT ["/usr/local/bin/hq-hermes-entrypoint"]
