import { describe, it, expect } from "vitest";
import { mapLuminancePhoto, clampSortAt, mapLuminanceSeries, mapLuminanceProfile } from "./luminance.js";
import { blobCid, selfLabelVals } from "./types.js";

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

describe("blobCid", () => {
  it("returns null (never false) for missing/malformed blobs", () => {
    expect(blobCid(undefined)).toBeNull();
    expect(blobCid(null)).toBeNull();
    expect(blobCid({})).toBeNull();
    expect(blobCid({ ref: "str" })).toBeNull();
    expect(blobCid({ ref: {} })).toBeNull(); // plain object toString is not a CID
  });
  it("extracts $link from JSON blob shape", () => {
    expect(blobCid({ ref: { $link: "bafkfoo" } })).toBe("bafkfoo");
  });
});

describe("selfLabelVals", () => {
  it("drops malformed entries instead of throwing or emitting 'undefined'", () => {
    expect(selfLabelVals({ $type: "com.atproto.label.defs#selfLabels", values: [{}, null, { val: "nudity" }] })).toEqual(["nudity"]);
  });
  it("returns [] for non-array values", () => {
    expect(selfLabelVals({ $type: "com.atproto.label.defs#selfLabels", values: "nope" })).toEqual([]);
  });
});

describe("mapLuminanceSeries malformed items", () => {
  it("skips null/blank entries without throwing", () => {
    const ctx = { did: "did:plc:k", collection: "social.luminance.portfolio.series", rkey: "1", cid: "c", indexedAt: new Date() };
    const m = mapLuminanceSeries(ctx, { title: "T", photos: [null, { uri: "at://did:plc:k/social.luminance.portfolio.photo/1" }, {}], createdAt: "2026-07-01T00:00:00Z" })!;
    expect(m.items).toEqual([{ photoUri: "at://did:plc:k/social.luminance.portfolio.photo/1", position: 1 }]);
  });
  it("is authoritative for membership even when photos is empty", () => {
    const ctx = { did: "did:plc:k", collection: "social.luminance.portfolio.series", rkey: "2", cid: "c", indexedAt: new Date() };
    const m = mapLuminanceSeries(ctx, { title: "T", photos: [], createdAt: "2026-07-01T00:00:00Z" })!;
    expect(m.itemsAuthoritative).toBe(true);
    expect(m.items).toEqual([]);
  });
});

describe("mapLuminanceProfile", () => {
  it("yields avatarCid null (not false) when no avatar", () => {
    expect(mapLuminanceProfile("did:plc:k", { displayName: "K" }).avatarCid).toBeNull();
  });
});
