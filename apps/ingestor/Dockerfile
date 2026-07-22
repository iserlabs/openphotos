# Ingestor: Jetstream firehose consumer + AppView indexer.
# Built from the monorepo root so pnpm/turbo can resolve workspace deps
# (@luminance/db, @luminance/atproto, @luminance/lexicons).
#
# Multi-stage: the build stage installs the full dependency graph and compiles
# TypeScript; the runtime stage carries ONLY production dependencies plus the
# compiled dist, so devDependencies (e.g. @electric-sql/pglite, pulled in by
# packages/db's test-db barrel export) never ship to production.
#
# Build context MUST be the repo root, e.g.:
#   docker build -f apps/ingestor/Dockerfile -t luminance-ingestor .

# ---- stage 1: build (all deps, compile) ----
FROM node:24-slim AS build

RUN corepack enable
WORKDIR /app

# Workspace metadata first for better layer caching. .npmrc pins
# auto-install-peers to match the lockfile so --frozen-lockfile doesn't mismatch.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY apps/ingestor ./apps/ingestor

RUN pnpm install --frozen-lockfile

# Builds ingestor plus its workspace dependencies (packages/db, atproto, lexicons).
RUN pnpm --filter ingestor... build

# ---- stage 2: runtime (production deps only) ----
FROM node:24-slim AS runtime

RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

# Manifests + lockfile only: enough for pnpm to resolve the workspace graph and
# install the production dependency closure of the ingestor.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/db/package.json ./packages/db/
COPY packages/atproto/package.json ./packages/atproto/
COPY packages/lexicons/package.json ./packages/lexicons/
COPY apps/ingestor/package.json ./apps/ingestor/

# --prod drops devDependencies; --filter ingestor... narrows to the ingestor and
# its workspace deps. Workspace packages are symlinked into node_modules and get
# their dist copied in below.
RUN pnpm install --frozen-lockfile --prod --filter ingestor...

# Compiled output from the build stage (into the symlinked workspace packages).
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/atproto/dist ./packages/atproto/dist
COPY --from=build /app/packages/lexicons/dist ./packages/lexicons/dist
# The lexicons dist imports the raw JSON lexicon docs at runtime (../lexicons/**).
COPY --from=build /app/packages/lexicons/lexicons ./packages/lexicons/lexicons
COPY --from=build /app/apps/ingestor/dist ./apps/ingestor/dist

EXPOSE 8080

CMD ["node", "apps/ingestor/dist/main.js"]
