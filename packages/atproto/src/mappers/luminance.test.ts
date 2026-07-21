import { describe, it, expect } from "vitest";
import { mapLuminancePhoto, clampSortAt } from "./luminance.js";

const ctx = { did: "did:plc:kevin", collection: "social.luminance.portfolio.photo", rkey: "3abc", cid: "bafyrec", indexedAt: new Date("2026-07-21T12:00:00Z") };
const record = {
  $type: "social.luminance.portfolio.photo",
  image: { $type: "blob", ref: { $link: "bafkimg" }, mimeType: "image/jpeg", size: 1000 },
  aspectRatio: { width: 3000, height: 2000 },
  alt: "Heron at dawn", title: "Dawn Patrol",
  capturedAt: "2026-07-01T09:30:00Z", createdAt: "2026-07-20T00:00:00Z",
  exif: { camera: "Nikon Z8", lens: "600mm f/6.3", iso: 640 },
  tags: ["wildlife"], license: "all-rights-reserved",
  labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "nudity" }] },
};

describe("clampSortAt", () => {
  const indexed = new Date("2026-07-21T12:00:00Z");
  it("passes through sane timestamps", () =>
    expect(clampSortAt(new Date("2026-07-01T00:00:00Z"), indexed).toISOString()).toBe("2026-07-01T00:00:00.000Z"));
  it("clamps future timestamps to indexedAt+10min", () =>
    expect(clampSortAt(new Date("2027-01-01T00:00:00Z"), indexed).toISOString()).toBe("2026-07-21T12:10:00.000Z"));
  it("falls back to indexedAt when null", () =>
    expect(clampSortAt(null, indexed)).toEqual(indexed));
});

describe("mapLuminancePhoto", () => {
  it("maps a full record", () => {
    const m = mapLuminancePhoto(ctx, record)!;
    expect(m).toMatchObject({
      atUri: "at://did:plc:kevin/social.luminance.portfolio.photo/3abc",
      mediaIndex: 0, source: "luminance", blobCid: "bafkimg",
      width: 3000, height: 2000, title: "Dawn Patrol",
      capturedAt: new Date("2026-07-01T09:30:00Z"),
      labels: ["nudity"], tags: ["wildlife"],
    });
    expect(m.sortAt).toEqual(new Date("2026-07-01T09:30:00Z")); // capturedAt wins
  });
  it("returns null for a record without a blob", () => {
    expect(mapLuminancePhoto(ctx, { ...record, image: undefined })).toBeNull();
  });
});
