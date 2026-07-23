import path from "path";
import { defineConfig, configDefaults } from "vitest/config";

// Node environment: this app's tests exercise server-side code (lib/*, route
// handlers) rather than rendered components, so no DOM environment is needed.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    // The default include glob (**/*.{test,spec}.*) would otherwise sweep up the
    // dev-env integration suite (integration/**/*.test.ts — slow, boots a real
    // PDS, run via `test:integration`) and the Playwright starter
    // (e2e/**/*.spec.ts — needs a live server + browser, run via `test:e2e`).
    // Both have their own configs/scripts and must stay out of `pnpm test`.
    exclude: [...configDefaults.exclude, "integration/**", "e2e/**"],
    // PGlite-backed tests (createTestDb) cold-start WASM Postgres; CI runners
    // routinely blow the default 5s on the first test of a file.
    testTimeout: 20_000,
  },
});
