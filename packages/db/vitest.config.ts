import { defineConfig } from "vitest/config";

// PGlite-backed tests (createTestDb) cold-start WASM Postgres; CI runners
// routinely blow the default 5s on the first test of a file (same pattern
// as apps/web/vitest.config.ts).
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20_000,
  },
});
