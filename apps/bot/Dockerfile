FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter bot...
USER node
CMD ["pnpm", "--filter", "bot", "start"]
