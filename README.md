# OpenPhotos

ATProto photo-sharing hub, live at **[luminance.social](https://luminance.social)**.

OpenPhotos is an **aggregator over photographers' own data**, not a silo.
Registered photographers' photos live as records in their *own* PDS repos —
Bluesky image posts (`app.bsky.feed.post`), Grain galleries (`social.grain.*`),
and `social.opencontent.*` portfolio records — and OpenPhotos indexes those
records into one shared feed with profile pages, photo pages, and a social
layer. The index is rebuildable from source repos at any time, and viewer
interactions (likes, comments, follows) are written as real Bluesky records in
the *viewer's* own repo, so they reach the photographer's Bluesky notifications
too.

## Naming: OpenPhotos vs. `luminance`

The product was renamed **Luminance → OpenPhotos** on 2026-07-30 (repo
`iserlabs/openphotos`). Live protocol and infrastructure identifiers
intentionally keep the old name because they are published or deployed:

| Identifier | Why it stays |
|---|---|
| `social.luminance.*` NSIDs | Published lexicons — NSIDs never change |
| `luminance.social` | Live production domain |
| Fly app `luminance-ingestor` | Deployed app name |
| Vercel project `luminance-social` | Linked deploy target |
| `luminance` value in the `photo_source` DB enum | Live data |

Prose says "OpenPhotos"; identifiers stay as-is. Do not rename them as a
cleanup.

## Layout

pnpm + Turborepo monorepo (Node 24, pnpm 10 — see `.nvmrc` / `packageManager`):

| Path | Package | What it is |
|---|---|---|
| `apps/web` | `web` | Next.js 16 (App Router) hub: feed, profile/photo pages, OAuth registration + viewer sign-in, notifications, admin, image proxy (`/img/[did]/[cid]/[preset]`). Deployed on Vercel. |
| `apps/ingestor` | `ingestor` | Long-running Jetstream firehose consumer + backfill/reconcile worker, plus the freshness probe, engagement sweep, and cache warmer. Deployed on Fly.io. |
| `packages/atproto` | `@openphotos/atproto` | Record mappers (bsky / grain / luminance profile / opencontent), AppView client, identity resolution, SSRF-guarded fetch, interaction record builders. |
| `packages/lexicons` | `@openphotos/lexicons` | NSID constants + validator; schema JSON for `social.luminance.actor.profile` and vendored `com.atproto.*` refs. (`social.opencontent.*` schemas are owned externally — see below.) |
| `packages/db` | `@openphotos/db` | Drizzle ORM schema, migrations, feed/social queries, PGlite test harness. Postgres (Neon) in production. |

## Quick start

```bash
pnpm install
pnpm build          # turbo build across the workspace
pnpm test           # unit tests (vitest; PGlite-backed, no network)
pnpm typecheck

pnpm --filter web dev   # dev server — copy apps/web/.env.example to .env.local first
```

Database migrations (Drizzle):

```bash
DATABASE_URL="<postgres-url>" pnpm --filter @openphotos/db exec drizzle-kit migrate
```

## Test layers

1. **Unit** — `pnpm test`. Fast, network-free; DB tests run against PGlite.
   Gates every push/PR in `.github/workflows/ci.yml` (which also checks
   lexicon/migration drift and, on push to main only, runs prod migrations).
2. **Dev-env integration** — `pnpm --filter web test:integration` and
   `pnpm --filter ingestor test:integration`. Spin a real local PDS via
   `@atproto/dev-env` (SQLite-native, no Docker) and exercise the live write
   path / backfill / rebuild drill. Excluded from the default `test` run; the
   web suite runs nightly in `.github/workflows/nightly.yml`.
3. **Playwright E2E** — `pnpm --filter web test:e2e`. Runs nightly against
   production (`E2E_BASE_URL=https://luminance.social`): feed render + srcset,
   params regression, image-proxy headers, label-blur reveal.

## Deploys

- **Web** — Vercel project `luminance-social`, Root Directory `apps/web`
  (`apps/web/vercel.json` hops to the repo root to build the workspace).
  Deploys on push to `main`.
- **Ingestor** — Fly app `luminance-ingestor` (iad), deployed by
  `.github/workflows/deploy-ingestor.yml`, which is gated on a **green `ci`
  run on `main`** (`workflow_run`), never directly on push. Manual deploy from
  the repo root: `fly deploy --config apps/ingestor/fly.toml --dockerfile
  apps/ingestor/Dockerfile`.
- **DB** — Neon Postgres; migrations apply in CI on push to `main`.

## Docs

- `docs/TODO.md` — **the source of truth for project status and open work.**
- `docs/runbooks/` — operational runbooks (alpha launch/redeploy, lexicon
  publishing).
- `docs/superpowers/` — historical design specs and implementation plans.
  Their checkboxes were **not** maintained during execution; trust the status
  banners, git history, and `docs/TODO.md` instead.

## Sibling repos (the OpenSocial family)

- **`opencontent-lexicons`** — governance repo and source of truth for the
  `social.opencontent.*` schemas OpenPhotos consumes. Lexicons lead; apps
  follow.
- **`openportfolio`** — the self-hostable ATProto portfolio CMS that publishes
  `social.opencontent.*` records OpenPhotos then indexes.
