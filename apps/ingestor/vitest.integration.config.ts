import { defineConfig } from "vitest/config";

// Integration suite: exercises the full ingest path against a REAL local PDS
// spun up by @atproto/dev-env (TestNetworkNoAppView). Excluded from the default
// `test` script; run explicitly with `pnpm --filter ingestor test:integration`.
//
// The dev-env PDS is SQLite-native (data in a temp dir) — no Docker/Postgres
// required. First run may take longer as services warm up, hence the generous
// timeouts below.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/integration/**/*.test.ts"],
    // dev-env boots a PLC + PDS on first `beforeAll`; give it room.
    hookTimeout: 120_000,
    testTimeout: 120_000,
    // Isolate: one long-lived network per file, never run these in parallel.
    fileParallelism: false,
  },
});
