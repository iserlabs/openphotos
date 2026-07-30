import { test, expect, type Page } from "@playwright/test";

// ── Photo-page social surfaces — Playwright starter (spec §9) ─────────────────
// LOCAL / PRE-RELEASE ONLY (see playwright.config.ts header): drives a real dev
// server against real data, NOT CI, NOT `turbo test`. Two smoke checks on the
// photo detail page's social region:
//   (a) the comments region renders (or the honest degraded copy in its place);
//   (b) a signed-out viewer is invited to sign in to comment, linking to /login.
// Both assume the feed contains at least one interaction-capable (bsky-sourced)
// photo — true for the alpha's data. With an empty dev DB they self-skip rather
// than false-fail.

/** Open the first photo linked from the feed; false if the feed has none. */
async function openFirstPhoto(page: Page): Promise<boolean> {
  await page.goto("/");
  const firstPhoto = page.locator('a[href^="/photo/"]').first();
  if ((await firstPhoto.count()) === 0) return false;
  await firstPhoto.click();
  await page.waitForURL(/\/photo\//);
  return true;
}

test("a photo page renders the comments region (or the degraded copy)", async ({ page }) => {
  test.skip(!(await openFirstPhoto(page)), "no photos in the feed to open — seed the dev DB first");

  const region = page.getByRole("heading", { name: "Comments", exact: true });
  const degraded = page.getByText("Comments temporarily unavailable", { exact: true });
  // The heading is present whether the live Bluesky thread renders or the
  // degraded copy stands in for it; either satisfies "the comments region".
  const shown = (await region.isVisible()) || (await degraded.isVisible());
  expect(shown).toBeTruthy();
});

test("signed-out photo page invites sign-in to comment, linking to /login", async ({ page }) => {
  test.skip(!(await openFirstPhoto(page)), "no photos in the feed to open — seed the dev DB first");

  // A fresh Playwright context carries no session cookie -> signed-out branch.
  await expect(page.getByText("Sign in to comment", { exact: false })).toBeVisible();
  // Scoped to main: the site header carries its own "Sign in" link, and an
  // unscoped role query is a strict-mode violation with both present.
  const signIn = page.getByRole("main").getByRole("link", { name: "Sign in", exact: true });
  await expect(signIn).toHaveAttribute("href", /^\/login/);
});
