# ingestor

Firehose consumer + backfill worker for luminance.social. Watches Jetstream,
maps ATProto records into the index (`@openphotos/db`), and backfills a
photographer's repo history from their PDS.

## Scripts

- `pnpm --filter ingestor test` — unit tests (fast; PGlite-backed, no network).
- `pnpm --filter ingestor test:integration` — full end-to-end suite against a
  **real local PDS**.
- `pnpm --filter ingestor build` / `typecheck` / `start`.

## Integration test (`src/integration/`)

`dev-env.test.ts` is the spec §13 integration gate and success-criterion 3
(the rebuild drill). It spins up a real PDS with
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
