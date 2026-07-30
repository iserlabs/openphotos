import { test, expect } from "@playwright/test";

// ── Feed + image-pipeline E2E (TODO §3 fast-follows) ──────────────────────────
// Same contract as photo-social.spec.ts: drives a REAL origin (local dev server
// or E2E_BASE_URL, e.g. production) with live data; data-dependent checks
// self-skip on an empty feed instead of false-failing. Per-photo hide is NOT
// here — it needs an authenticated owner session (real OAuth+DPoP), and stays
// covered by the queries unit tests + the dev-env integration suite.

test("feed renders photo tiles carrying responsive srcset renditions", async ({ page }) => {
  await page.goto("/");
  const tiles = page.locator('a[href^="/photo/"]');
  test.skip((await tiles.count()) === 0, "empty feed — nothing to assert");

  const img = tiles.first().locator("img");
  await expect(img).toBeVisible();
  const srcset = await img.getAttribute("srcset");
  expect(srcset).toContain("/thumb 512w");
  expect(srcset).toContain("/grid 768w");
  expect(srcset).toContain("/feed 1024w");
});

test("photo-page navigation survives Next 16 percent-encoded params (prod regression)", async ({ page }) => {
  await page.goto("/");
  const tile = page.locator('a[href^="/photo/"]').first();
  test.skip((await tile.count()) === 0, "empty feed — nothing to navigate to");

  // Navigate by URL (not click): the regression was the PAGE receiving
  // `did%3Aplc%3A…` params and failing to decode them — a direct request is
  // the same code path a shared/bookmarked link takes.
  const href = (await tile.getAttribute("href"))!;
  expect(href).toContain("did%3A"); // premise: the did IS percent-encoded in hrefs
  const response = await page.goto(href);
  expect(response!.status()).toBe(200); // the bug rendered 404s here
  await expect(page.locator("figure img").first()).toBeVisible();
});

test("image proxy serves allowlisted renditions with immutable caching keyed on Accept", async ({ page, request }) => {
  await page.goto("/");
  const img = page.locator('a[href^="/photo/"] img').first();
  test.skip((await img.count()) === 0, "empty feed — no image to fetch");

  const src = (await img.getAttribute("src"))!;
  const response = await request.get(src, { headers: { accept: "image/webp" } });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("immutable");
  expect((response.headers()["vary"] ?? "").toLowerCase()).toContain("accept");
});

test("image proxy 404s a blob the index does not reference, with a shorter negative cache", async ({ request }) => {
  const response = await request.get(
    "/img/did%3Aplc%3Adoesnotexist/bafkreiunknownunknownunknownunknown/thumb",
  );
  expect(response.status()).toBe(404);
  expect(response.headers()["cache-control"]).toContain("max-age=300");
});

test("sensitive tiles blur behind a reveal step (self-skips when none present)", async ({ page }) => {
  await page.goto("/");
  const reveal = page.getByRole("button", { name: /sensitive content/i }).first();
  test.skip((await reveal.count()) === 0, "no labeled photos in the current feed");

  await reveal.click();
  await expect(reveal).toHaveCount(0); // reveal replaces the gate with the normal linked tile
});
