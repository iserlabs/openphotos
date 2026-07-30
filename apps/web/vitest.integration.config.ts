import path from "path";
import { defineConfig } from "vitest/config";

// Integration suite: exercises the social write path against a REAL local PDS
// spun up by @atproto/dev-env (TestNetworkNoAppView). Excluded from the default
// `test` script (see vitest.config.ts `exclude`); run explicitly with
// `pnpm --filter web test:integration`.
//
// The dev-env PDS is SQLite-native (data in a temp dir) — no Docker/Postgres
// required. First run may take longer as services warm up, hence the generous
// timeouts below. Mirrors apps/ingestor/vitest.integration.config.ts.
export default defineConfig({
  resolve: {
    // Same `@` alias the app and default vitest config use, so the service code
    // under test resolves its own imports identically here.
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    environment: "node",
    include: ["integration/**/*.test.ts"],
    // dev-env boots a PLC + PDS on first `beforeAll`; give it room.
    hookTimeout: 120_000,
    testTimeout: 120_000,
    // Isolate: one long-lived network per file, never run these in parallel.
    fileParallelism: false,
  },
});
