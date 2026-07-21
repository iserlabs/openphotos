# Ingestor: Jetstream firehose consumer + AppView indexer.
# Built from the monorepo root so pnpm/turbo can resolve workspace deps
# (@luminance/db, @luminance/atproto, @luminance/lexicons).
#
# Build context MUST be the repo root, e.g.:
#   docker build -f apps/ingestor/Dockerfile -t luminance-ingestor .

FROM node:24-slim

RUN corepack enable

WORKDIR /app

# Workspace metadata first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/ingestor ./apps/ingestor

RUN pnpm install --frozen-lockfile

# Builds ingestor plus its workspace dependencies (packages/db, atproto, lexicons).
RUN pnpm --filter ingestor... build

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "apps/ingestor/dist/main.js"]
