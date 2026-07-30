import { describe, it, expect } from "vitest";
import { clampSortAt, mapLuminanceProfile } from "./luminance.js";
import { blobCid, selfLabelVals } from "./types.js";

// mapLuminancePhoto/mapLuminanceSeries were deleted with social.luminance.portfolio.*
// (retired 2026-07-28, zero records ever existed — see
// docs/runbooks/publish-lexicons.md §7). clampSortAt is a shared helper (used
// by bsky/grain/opencontent mappers too) and mapLuminanceProfile still backs
// the active social.luminance.actor.profile — both keep their coverage here.

describe("clampSortAt", () => {
  const indexed = new Date("2026-07-21T12:00:00Z");
  it("passes through sane timestamps", () =>
    expect(clampSortAt(new Date("2026-07-01T00:00:00Z"), indexed).toISOString()).toBe("2026-07-01T00:00:00.000Z"));
  it("clamps future timestamps to indexedAt+10min", () =>
    expect(clampSortAt(new Date("2027-01-01T00:00:00Z"), indexed).toISOString()).toBe("2026-07-21T12:10:00.000Z"));
  it("falls back to indexedAt when null", () =>
    expect(clampSortAt(null, indexed)).toEqual(indexed));
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

describe("mapLuminanceProfile", () => {
  it("yields avatarCid null (not false) when no avatar", () => {
    expect(mapLuminanceProfile("did:plc:k", { displayName: "K" }).avatarCid).toBeNull();
  });
});
