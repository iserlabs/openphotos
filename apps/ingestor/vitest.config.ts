import { defineConfig, configDefaults } from "vitest/config";

// Default unit-test run. The dev-env integration suite (src/integration/**) is
// long-running and spins up a real local PDS, so it is excluded here and run
// separately via `pnpm --filter ingestor test:integration`. This keeps the
// default `pnpm test` (and CI) green without any extra infrastructure.
export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "src/integration/**"],
  },
});
