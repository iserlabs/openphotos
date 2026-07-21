import { describe, it, expect } from "vitest";
import { createTestDb, photos, photographers, photoOverrides } from "@luminance/db";
import { getPhotoRecord, getPhotographerByHandle } from "./queries";

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
});
