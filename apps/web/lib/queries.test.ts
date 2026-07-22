import { describe, it, expect } from "vitest";
import { createTestDb, photos, photographers, photoOverrides, series, seriesPhotos } from "@luminance/db";
import { getPhotoRecord, getPhotographerByHandle, getSeries } from "./queries";

describe("queries", () => {
  it("getPhotoRecord returns all media rows of a multi-image post, minus taken-down ones", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:a", handle: "klee.photos" });
    const uri = "at://did:plc:a/app.bsky.feed.post/1";
    await db.insert(photos).values([0, 1, 2].map((i) => ({ atUri: uri, mediaIndex: i, did: "did:plc:a", source: "bsky" as const, recordCid: "r", blobCid: `b${i}`, sortAt: new Date() })));
    await db.insert(photoOverrides).values({ atUri: uri, mediaIndex: 1, takedown: true });
    const rec = await getPhotoRecord(db, uri);
    expect(rec!.items.map((i) => i.mediaIndex)).toEqual([0, 2]);
  });
  it("getPhotographerByHandle only returns active photographers", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:a", handle: "gone.photos", status: "deregistered" });
    expect(await getPhotographerByHandle(db, "gone.photos")).toBeNull();
  });
  it("getSeries omits hidden and taken-down photos from its items", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:a", handle: "klee.photos" });
    const seriesUri = "at://did:plc:a/social.luminance.portfolio.series/s1";
    const uri = (n: number) => `at://did:plc:a/social.luminance.portfolio.photo/${n}`;
    await db.insert(photos).values([1, 2, 3].map((n) => ({ atUri: uri(n), mediaIndex: 0, did: "did:plc:a", source: "luminance" as const, recordCid: "r", blobCid: `b${n}`, sortAt: new Date() })));
    await db.insert(series).values({ atUri: seriesUri, did: "did:plc:a", title: "S" });
    await db.insert(seriesPhotos).values([1, 2, 3].map((n) => ({ seriesUri, photoUri: uri(n), position: n })));
    await db.insert(photoOverrides).values([
      { atUri: uri(1), mediaIndex: 0, hidden: true },
      { atUri: uri(2), mediaIndex: 0, takedown: true },
    ]);
    const found = await getSeries(db, seriesUri);
    expect(found!.items.map((i) => i.atUri)).toEqual([uri(3)]);
  });
});
