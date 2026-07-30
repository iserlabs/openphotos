# CLAUDE.md

Guidance for Claude Code when working in this repository (OpenPhotos — ATProto
photo-sharing hub at luminance.social).

## Layout

pnpm + Turborepo monorepo. `apps/web` (Next.js 16 hub, Vercel),
`apps/ingestor` (Jetstream consumer + backfill, Fly.io app
`luminance-ingestor`), `packages/atproto` (record mappers + clients),
`packages/lexicons` (schemas + NSID constants), `packages/db` (Drizzle/Neon).
See `README.md` for the full map.

## Commands (verified)

```bash
pnpm install
pnpm build / pnpm test / pnpm typecheck        # turbo, whole workspace
pnpm --filter web dev                          # dev server (.env.local needed)
pnpm --filter web test:integration             # dev-env PDS integration suite
pnpm --filter ingestor test:integration        # rebuild-drill integration suite
pnpm --filter web test:e2e                     # Playwright (nightly runs vs prod)
DATABASE_URL=... pnpm --filter @openphotos/db exec drizzle-kit migrate
```

## Hard rules

- **Never rename live `luminance` identifiers**: `social.luminance.*` NSIDs,
  the `luminance.social` domain, Fly app `luminance-ingestor`, Vercel project
  `luminance-social`, the `luminance` value in the `photo_source` enum. They
  intentionally keep the pre-2026-07-30 brand name because they are
  published/live. Prose says "OpenPhotos"; identifiers stay.
- **Never edit Drizzle migration snapshots** (`packages/db/migrations/`,
  including `meta/`). New schema changes go through
  `drizzle-kit generate`; CI's drift check fails on uncommitted output.
- **`docs/TODO.md` is the source of truth for status/open work.** The
  checkboxes in `docs/superpowers/plans/*` were NEVER maintained during
  execution (they show 0 checked on fully shipped plans) — do not read them as
  status and do not "fix" them; the status banners, git history, and TODO.md
  are authoritative.
- **Consumer contract** (family-wide, from `opencontent-lexicons`): dangling
  strongRefs are skipped, never an error; unknown record fields are ignored;
  unlisted collections still render.

## Load-bearing seams

- **Interactions router** — `apps/web/lib/interactions.ts` `routeInteraction`,
  keyed on `photo.source`: `bsky` → real Bluesky records against the
  underlying post; `grain` and `opencontent` → `{ supported: false }` (the
  opencontent branch is intentionally unsupported until phase 3b — see
  `docs/TODO.md` §2).
- **Watched collections** live in TWO places that must stay in sync:
  `WANTED_COLLECTIONS` in `apps/ingestor/src/main.ts` (Jetstream filter) and
  `WATCHED` in `apps/ingestor/src/backfill.ts` (backfill/reconcile walk).
- Index tables (`photos`, `series`, `series_photos`, `tombstones`) are
  rebuildable from PDS data by design; app-state tables (`photographers`,
  OAuth stores, interactions, notifications) are durable.
- Top-level routes in `apps/web/app/` must be **dotless** — `/[handle]`
  resolves Bluesky handles (which always contain a dot) off the root path.

## Sibling repos

- `../opencontent-lexicons` — source of truth for `social.opencontent.*`
  schemas. Schema changes land there first; this repo only consumes.
- `../openportfolio` — self-hostable portfolio CMS that publishes the records
  this app indexes.
