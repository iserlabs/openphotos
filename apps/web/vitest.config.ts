import { defineConfig } from "vitest/config";

// Node environment: this app's tests exercise server-side code (lib/*, route
// handlers) rather than rendered components, so no DOM environment is needed.
export default defineConfig({
  test: {
    environment: "node",
  },
});
