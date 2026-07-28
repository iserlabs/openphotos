import { describe, it, expect } from "vitest";
import { mapOpencontentPhotograph, mapOpencontentCollection } from "./opencontent.js";
import photograph from "./fixtures/opencontent-photograph.json" with { type: "json" };
import collection from "./fixtures/opencontent-collection.json" with { type: "json" };

const photoCtx = {
  did: "did:plc:kleephotos", collection: "social.opencontent.photograph", rkey: "3lqrs001",
  cid: "bafyreiphoto1", indexedAt: new Date("2026-07-20T00:10:00Z"),
};
const collectionCtx = {
  did: "did:plc:kleephotos", collection: "social.opencontent.collection", rkey: "3lqrscoll",
  cid: "bafyreicoll1", indexedAt: new Date("2026-07-20T00:10:00Z"),
};

describe("mapOpencontentPhotograph", () => {
  it("maps a full record: aspectRatio->width/height, exif/tags/license through, sortAt=createdAt", () => {
    const m = mapOpencontentPhotograph(photoCtx, photograph)!;
    expect(m).toMatchObject({
      atUri: "at://did:plc:kleephotos/social.opencontent.photograph/3lqrs001",
      mediaIndex: 0, source: "opencontent",
      blobCid: "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
      width: 5760, height: 3840,
      title: "Osprey at First Light",
      caption: "An osprey banking over the reservoir just after sunrise, wings fully extended.",
      alt: "An osprey in flight against a pale orange sky, wings spread wide, talons tucked.",
      tags: ["osprey", "raptor", "reservoir", "sunrise"],
      license: "CC-BY-NC-4.0",
      labels: ["nudity"],
    });
    expect(m.capturedAt).toEqual(new Date("2026-07-15T10:42:00.000Z"));
    expect(m.createdAt).toEqual(new Date("2026-07-20T00:00:00.000Z"));
    expect(m.sortAt).toEqual(new Date("2026-07-20T00:00:00.000Z")); // sortAt = createdAt (not capturedAt)
    // exif/location: no dedicated `location` column on `photos` — folded into the
    // existing exif jsonb bucket alongside camera/lens/etc.
    expect(m.exif).toMatchObject({ camera: "Nikon Z9", lens: "NIKKOR Z 600mm f/6.3 VR S", iso: 800, location: "Wanaque Reservoir, NJ" });
  });

  it("returns null for a record missing the image blob", () => {
    expect(mapOpencontentPhotograph(photoCtx, { ...photograph, image: undefined })).toBeNull();
  });

  it("returns null for a record missing aspectRatio", () => {
    expect(mapOpencontentPhotograph(photoCtx, { ...photograph, aspectRatio: undefined })).toBeNull();
  });

  it("returns null for a record with an invalid aspectRatio (non-integer / zero)", () => {
    expect(mapOpencontentPhotograph(photoCtx, { ...photograph, aspectRatio: { width: 0, height: 3840 } })).toBeNull();
    expect(mapOpencontentPhotograph(photoCtx, { ...photograph, aspectRatio: { width: "5760", height: 3840 } })).toBeNull();
  });

  it("never throws on a garbage record", () => {
    expect(mapOpencontentPhotograph(photoCtx, null)).toBeNull();
    expect(mapOpencontentPhotograph(photoCtx, {})).toBeNull();
    expect(mapOpencontentPhotograph(photoCtx, "not an object")).toBeNull();
  });

  it("maps selfLabels to a labels array", () => {
    const m = mapOpencontentPhotograph(photoCtx, photograph)!;
    expect(m.labels).toEqual(["nudity"]);
  });

  it("defaults optional fields to null/[] when absent", () => {
    const minimal = {
      image: photograph.image, aspectRatio: photograph.aspectRatio, createdAt: photograph.createdAt,
    };
    const m = mapOpencontentPhotograph(photoCtx, minimal)!;
    expect(m).toMatchObject({ title: null, caption: null, alt: null, license: null, tags: [], labels: [], exif: null, capturedAt: null });
  });

  it("happy path: valid exif passes through unchanged", () => {
    const m = mapOpencontentPhotograph(photoCtx, photograph)!;
    expect(m.exif).toEqual({
      camera: "Nikon Z9", lens: "NIKKOR Z 600mm f/6.3 VR S", focalLength: "600mm",
      fNumber: "6.3", shutterSpeed: "1/3200", iso: 800, location: "Wanaque Reservoir, NJ",
    });
  });

  it("untrusted-publisher hardening: drops non-primitive exif members, clamps oversized strings, caps tags at 20", () => {
    const oversizedLocation = "x".repeat(2000);
    const hostile = {
      ...photograph,
      exif: {
        camera: "Nikon Z9", // valid string, kept
        lens: ["not", "a", "string"], // non-primitive, dropped
        focalLength: "600mm", // valid string, kept
        fNumber: 6.3, // wrong type (number, spec requires string), dropped
        shutterSpeed: "1/3200", // valid string, kept
        iso: {}, // non-primitive, dropped
      },
      location: oversizedLocation,
      tags: [
        ...Array.from({ length: 20 }, (_, i) => `tag${i}`),
        { not: "a string" }, 42, null, ["nested"],
        "tag20", "tag21", "tag22", "tag23", "tag24",
      ],
    };
    const m = mapOpencontentPhotograph(photoCtx, hostile)!;

    // Only primitives ever enter the jsonb.
    for (const v of Object.values(m.exif!)) {
      expect(["string", "number"]).toContain(typeof v);
    }
    expect(m.exif).toEqual({
      camera: "Nikon Z9", focalLength: "600mm", shutterSpeed: "1/3200",
      location: "x".repeat(800),
    });
    expect(m.exif!.lens).toBeUndefined();
    expect(m.exif!.fNumber).toBeUndefined();
    expect(m.exif!.iso).toBeUndefined();
    expect(Buffer.byteLength((m.exif as Record<string, string>).location, "utf8")).toBe(800);

    // Tags: max 20 entries, non-strings dropped, order preserved among strings.
    expect(m.tags).toHaveLength(20);
    for (const t of m.tags) expect(typeof t).toBe("string");
    expect(m.tags[0]).toBe("tag0");
    expect(m.tags[19]).toBe("tag19");
  });

  it("untrusted-publisher hardening: clamps oversized exif string members to 256 bytes", () => {
    const oversized = "y".repeat(1000);
    const hostile = { ...photograph, exif: { camera: oversized } };
    const m = mapOpencontentPhotograph(photoCtx, hostile)!;
    expect(Buffer.byteLength((m.exif as Record<string, string>).camera, "utf8")).toBe(256);
  });

  it("untrusted-publisher hardening: iso only accepted as a finite non-negative integer", () => {
    const base = { ...photograph, location: undefined };
    expect(mapOpencontentPhotograph(photoCtx, { ...base, exif: { iso: 3.5 } })!.exif).toBeNull();
    expect(mapOpencontentPhotograph(photoCtx, { ...base, exif: { iso: -1 } })!.exif).toBeNull();
    expect(mapOpencontentPhotograph(photoCtx, { ...base, exif: { iso: Infinity } })!.exif).toBeNull();
    expect(mapOpencontentPhotograph(photoCtx, { ...base, exif: { iso: "800" } })!.exif).toBeNull();
    expect(mapOpencontentPhotograph(photoCtx, { ...base, exif: { iso: 0 } })!.exif).toEqual({ iso: 0 });
  });
});

describe("mapOpencontentCollection", () => {
  it("maps title/description/createdAt, cover->coverPhotoUri, and order-preserved items", () => {
    const m = mapOpencontentCollection(collectionCtx, collection)!;
    expect(m).toMatchObject({
      atUri: "at://did:plc:kleephotos/social.opencontent.collection/3lqrscoll",
      title: "Bosque del Apache, Winter 2026",
      description: "A week photographing snow geese and sandhill cranes at the refuge.",
      coverPhotoUri: "at://did:plc:kleephotos/social.opencontent.photograph/3lqrs002",
      itemsAuthoritative: true,
    });
    expect(m.createdAt).toEqual(new Date("2026-07-20T00:00:00.000Z"));
    expect(m.items).toEqual([
      { photoUri: "at://did:plc:kleephotos/social.opencontent.photograph/3lqrs001", position: 0 },
      { photoUri: "at://did:plc:kleephotos/social.opencontent.photograph/3lqrs002", position: 1 },
      { photoUri: "at://did:plc:kleephotos/social.opencontent.photograph/3lqrs003", position: 2 },
    ]);
  });

  it("passes dangling item uris through unchanged (hub joins skip them, not the mapper)", () => {
    const withDangling = {
      ...collection,
      items: [
        ...collection.items,
        { uri: "at://did:plc:kleephotos/social.opencontent.photograph/deleted999", cid: "bafyreideleted" },
      ],
    };
    const m = mapOpencontentCollection(collectionCtx, withDangling)!;
    expect(m.items).toHaveLength(4);
    expect(m.items[3]).toEqual({ photoUri: "at://did:plc:kleephotos/social.opencontent.photograph/deleted999", position: 3 });
  });

  it("is authoritative for membership even when items is empty", () => {
    const m = mapOpencontentCollection(collectionCtx, { title: "Empty", items: [], createdAt: "2026-07-01T00:00:00Z" })!;
    expect(m.itemsAuthoritative).toBe(true);
    expect(m.items).toEqual([]);
  });

  it("skips null/blank entries without throwing", () => {
    const m = mapOpencontentCollection(collectionCtx, {
      title: "T", items: [null, { uri: "at://did:plc:k/social.opencontent.photograph/1" }, {}],
      createdAt: "2026-07-01T00:00:00Z",
    })!;
    expect(m.items).toEqual([{ photoUri: "at://did:plc:k/social.opencontent.photograph/1", position: 1 }]);
  });

  it("returns null for a record missing a title", () => {
    expect(mapOpencontentCollection(collectionCtx, { ...collection, title: undefined })).toBeNull();
  });

  it("returns null for a record whose items is not an array", () => {
    expect(mapOpencontentCollection(collectionCtx, { ...collection, items: undefined })).toBeNull();
  });

  it("returns null with no cover (coverPhotoUri falls back to null; renderer picks first item)", () => {
    const m = mapOpencontentCollection(collectionCtx, { ...collection, cover: undefined })!;
    expect(m.coverPhotoUri).toBeNull();
  });

  it("never throws on a garbage record", () => {
    expect(mapOpencontentCollection(collectionCtx, null)).toBeNull();
    expect(mapOpencontentCollection(collectionCtx, {})).toBeNull();
    expect(mapOpencontentCollection(collectionCtx, "not an object")).toBeNull();
  });

  it("untrusted-publisher hardening: caps items at 500 entries, excess truncated, order preserved", () => {
    const bigItems = Array.from({ length: 510 }, (_, i) => ({
      uri: `at://did:plc:kleephotos/social.opencontent.photograph/item${i}`,
      cid: `bafyreibig${i}`,
    }));
    const m = mapOpencontentCollection(collectionCtx, {
      title: "Huge Collection", items: bigItems, createdAt: "2026-07-01T00:00:00Z",
    })!;
    expect(m.items).toHaveLength(500);
    expect(m.items[0]).toEqual({ photoUri: "at://did:plc:kleephotos/social.opencontent.photograph/item0", position: 0 });
    expect(m.items[499]).toEqual({ photoUri: "at://did:plc:kleephotos/social.opencontent.photograph/item499", position: 499 });
  });
});
