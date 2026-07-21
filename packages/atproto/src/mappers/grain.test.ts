import { describe, it, expect } from "vitest";
import { mapGrainRecord, GRAIN_COLLECTIONS, GRAIN_PHOTO, GRAIN_GALLERY, GRAIN_GALLERY_ITEM } from "./grain.js";
import photo from "./fixtures/grain-photo.json" with { type: "json" };
import gallery from "./fixtures/grain-gallery.json" with { type: "json" };
import item from "./fixtures/grain-gallery-item.json" with { type: "json" };

describe("mapGrainRecord", () => {
  it("declares the verified collection NSIDs", () => {
    expect(GRAIN_COLLECTIONS.length).toBeGreaterThanOrEqual(2);
    expect(GRAIN_COLLECTIONS.every((c) => c.startsWith("social.grain."))).toBe(true);
    expect(GRAIN_COLLECTIONS).toEqual(["social.grain.photo", "social.grain.gallery", "social.grain.gallery.item"]);
  });

  it("maps a grain photo to MappedPhoto with source=grain, mediaIndex 0", () => {
    const ctx = { did: "did:plc:g", collection: GRAIN_PHOTO, rkey: "1", cid: "c", indexedAt: new Date("2026-04-08T03:00:00Z") };
    const m = mapGrainRecord(ctx, photo)!;
    expect(m.photo).toMatchObject({
      source: "grain",
      mediaIndex: 0,
      width: 2000,
      height: 1334,
      title: null,
      caption: null,
    });
    expect(m.photo!.blobCid).toBe("bafkreicmhcy2i77qnm4gueg62spdupzxcvgvmsfiqlmrj6lbsdfesbsqxq");
    expect(m.photo!.alt).toContain("great blue heron");
  });

  it("returns null for a photo record with no blob", () => {
    const ctx = { did: "did:plc:g", collection: GRAIN_PHOTO, rkey: "1", cid: "c", indexedAt: new Date() };
    expect(mapGrainRecord(ctx, { alt: "no photo here", createdAt: "2026-01-01T00:00:00Z" })).toBeNull();
  });

  it("maps a gallery record to a MappedSeries with no items (membership is separate)", () => {
    const gctx = { did: "did:plc:g", collection: GRAIN_GALLERY, rkey: "2", cid: "c", indexedAt: new Date() };
    const g = mapGrainRecord(gctx, gallery)!;
    expect(g.series).toMatchObject({
      title: "Hello, here are some birds!",
      description: gallery.description,
      coverPhotoUri: null,
      items: [],
    });
  });

  it("maps a gallery.item record to a seriesItem with gallery/item at-uris and position", () => {
    expect(GRAIN_COLLECTIONS.length).toBeGreaterThan(2);
    const ictx = { did: "did:plc:g", collection: GRAIN_GALLERY_ITEM, rkey: "3", cid: "c", indexedAt: new Date() };
    const si = mapGrainRecord(ictx, item);
    expect(si!.seriesItem).toEqual({
      seriesUri: item.gallery,
      photoUri: item.item,
      position: 5,
    });
  });

  it("returns null for an unknown collection", () => {
    const ctx = { did: "did:plc:g", collection: "social.grain.comment", rkey: "9", cid: "c", indexedAt: new Date() };
    expect(mapGrainRecord(ctx, {})).toBeNull();
  });
});
