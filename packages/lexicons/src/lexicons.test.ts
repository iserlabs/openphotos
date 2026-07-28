import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { lexiconValidator, LUMINANCE_PROFILE } from "./index.js";

// social.luminance.portfolio.{photo,series} were retired (zero records ever
// existed — see docs/runbooks/publish-lexicons.md §7); social.luminance.actor.profile
// is the only home-authored lexicon left in `lexicons`, so it carries this
// suite's coverage of the validator itself (well-formed/malformed records,
// blob hydration, and the no-GPS-fields guard).
describe("luminance lexicons", () => {
  it("validates a well-formed profile record", () => {
    const res = lexiconValidator.validate(LUMINANCE_PROFILE, {
      $type: LUMINANCE_PROFILE,
      displayName: "Kevin",
      bio: "Wildlife photographer",
      websiteUrl: "https://klee.photos",
      location: "Bergen County, NJ",
    });
    expect(res.success).toBe(true);
  });
  it("rejects a malformed profile (websiteUrl failing the uri format check)", () => {
    const res = lexiconValidator.validate(LUMINANCE_PROFILE, {
      $type: LUMINANCE_PROFILE,
      websiteUrl: "not a url",
    });
    expect(res.success).toBe(false);
  });
  it("has no GPS-shaped fields anywhere", () => {
    const raw = readFileSync(
      fileURLToPath(new URL("../lexicons/social/luminance/actor/profile.json", import.meta.url)),
      "utf-8",
    );
    expect(raw.toLowerCase()).not.toMatch(/gps|latitude|longitude/);
  });
  it("validates a profile record carrying an avatar blob (blob hydration)", () => {
    const res = lexiconValidator.validate(LUMINANCE_PROFILE, {
      $type: LUMINANCE_PROFILE,
      avatar: { $type: "blob", ref: { $link: "bafkreib3vqp" }, mimeType: "image/jpeg", size: 12345 },
    });
    expect(res.success).toBe(true);
  });
});
