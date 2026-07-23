import { defineConfig, devices } from "@playwright/test";

// ── Playwright starter (spec §9) ──────────────────────────────────────────────
// LOCAL / PRE-RELEASE ONLY — this suite is deliberately NOT part of CI and is NOT
// wired into `turbo test`. It drives a REAL running dev server (`next dev` /
// `next start`) backed by a real DATABASE_URL and real env from `.env.local`,
// because the social surfaces it checks (thread region, signed-out composer)
// depend on live data and session state that PGlite/unit tests don't model.
//
// Run it by hand before a release:
//   1. In one terminal:  pnpm --filter web dev   (or `build` + `start`)
//   2. In another:        pnpm --filter web test:e2e
//      (first run only:    pnpm --filter web exec playwright install chromium)
//
// Target a non-default origin with E2E_BASE_URL, e.g. a preview deploy:
//   E2E_BASE_URL=https://luminance-social.vercel.app pnpm --filter web test:e2e
export default defineConfig({
  testDir: "./e2e",
  // Fail fast if someone left a `.only` in a spec when running the release gate.
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
