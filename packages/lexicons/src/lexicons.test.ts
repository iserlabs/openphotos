import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { lexiconValidator, LUMINANCE_PHOTO } from "./index.js";

describe("luminance lexicons", () => {
  it("validates a well-formed photo record", () => {
    const res = lexiconValidator.validate(LUMINANCE_PHOTO, {
      $type: LUMINANCE_PHOTO,
      image: { $type: "blob", ref: { $link: "bafkreib3vqp" }, mimeType: "image/jpeg", size: 12345 },
      createdAt: "2026-07-21T00:00:00.000Z",
      exif: { camera: "Nikon Z8", iso: 640 },
    });
    expect(res.success).toBe(true);
  });
  it("rejects a photo without an image", () => {
    const res = lexiconValidator.validate(LUMINANCE_PHOTO, { $type: LUMINANCE_PHOTO, createdAt: "2026-07-21T00:00:00.000Z" });
    expect(res.success).toBe(false);
  });
  it("has no GPS-shaped fields anywhere", () => {
    const raw = readFileSync(
      fileURLToPath(new URL("../lexicons/social/luminance/portfolio/photo.json", import.meta.url)),
      "utf-8",
    );
    expect(raw.toLowerCase()).not.toMatch(/gps|latitude|longitude/);
  });
});
