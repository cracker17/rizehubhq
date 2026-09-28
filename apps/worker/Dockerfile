# Playwright base image: headless Chromium for QA screenshots (M9).
FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter worker...
ENV NODE_ENV=production TZ=Asia/Manila AGENTS_DIR=/app/agents BRAIN_DIR=/app/brain WORKSPACES_DIR=/app/workspaces MODELS_FILE=/app/config/models.yaml
CMD ["pnpm", "--filter", "worker", "start"]
