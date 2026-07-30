# ingestor

Firehose consumer + backfill worker for OpenPhotos (luminance.social).
Watches Jetstream for registered photographers' records, maps them into the
index (`@openphotos/db`), and backfills a photographer's repo history from
their PDS. It also runs the periodic loops: PDS-truth reconciliation (hourly
re-backfill diffing), the per-photographer freshness probe (45s
`getLatestCommit` poll — the mitigation for Jetstream's best-effort delivery),
the engagement sweep (Bluesky AppView like/reply/follower counts +
notifications), and the image-cache warmer.

Deployed as Fly.io app `luminance-ingestor` (`fly.toml`) by
`.github/workflows/deploy-ingestor.yml`, gated on a green CI run on `main`.
Watched collections are defined in `src/main.ts` (`WANTED_COLLECTIONS`, the
Jetstream filter) and `src/backfill.ts` (`WATCHED`, the backfill walk) — keep
the two in sync.

## Scripts

- `pnpm --filter ingestor test` — unit tests (fast; PGlite-backed, no network).
- `pnpm --filter ingestor test:integration` — full end-to-end suite against a
  **real local PDS**.
- `pnpm --filter ingestor build` / `typecheck` / `start`.

## Integration test (`src/integration/`)

`dev-env.test.ts` is the integration gate from the foundation design
(`docs/superpowers/specs/2026-07-21-luminance-foundation-design.md` §13) and
success-criterion 3 (the rebuild drill). It spins up a real PDS with
[`@atproto/dev-env`](https://www.npmjs.com/package/@atproto/dev-env)
(`TestNetworkNoAppView`), writes real photo records, backfills them over HTTP,
honors a live delete, then drops the index and rebuilds it to convergence.

It is **excluded from the default `test` script** (and therefore CI) via
`vitest.config.ts`, and runs only under `test:integration` (which uses
`vitest.integration.config.ts`).

Requirements:

- **No Docker/Postgres.** The dev-env PDS is SQLite-native (data in a temp dir).
  This differs from older dev-env docs that assumed a Postgres AppView.
- The PDS's SQLite driver is `better-sqlite3`, a native module. It is listed in
  the root `pnpm.onlyBuiltDependencies` so its binding is compiled on install.
  If you see "Could not locate the bindings file", run
  `pnpm rebuild -r better-sqlite3`.
- The local PDS serves plain **HTTP** on `localhost`, which the production
  `safeJsonFetch` SSRF guard would (correctly) refuse — so the test injects its
  own `fetchJson`/`resolvePds` into `runBackfill`. The production guard is left
  untouched.
