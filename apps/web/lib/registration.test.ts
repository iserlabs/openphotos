import { describe, it, expect } from "vitest";
import { createTestDb, photographers, photoOverrides, photos, series, seriesPhotos } from "@luminance/db";
import { eq } from "drizzle-orm";
import {
  completeRegistration,
  setHiddenForDid,
  deregisterDid,
  updateSourceToggles,
} from "./registration";

describe("registration logic", () => {
  it("creates an active photographer with pending backfill and chosen toggles", async () => {
    const db = await createTestDb();
    await completeRegistration(db, { did: "did:plc:k", handle: "klee.photos", includeBsky: true, includeGrain: false });
    const [p] = await db.select().from(photographers);
    expect(p).toMatchObject({ status: "active", backfillStatus: "pending", includeGrain: false });
  });
  it("re-registering an existing did updates toggles without duplicating", async () => {
    const db = await createTestDb();
    await completeRegistration(db, { did: "did:plc:k", handle: "klee.photos", includeBsky: true, includeGrain: true });
    await completeRegistration(db, { did: "did:plc:k", handle: "klee.photos", includeBsky: false, includeGrain: true });
    const rows = await db.select().from(photographers);
    expect(rows).toHaveLength(1);
    expect(rows[0].includeBsky).toBe(false);
  });
  it("hide writes an override only for the caller's own photo", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:k", handle: "k.photos" });
    await db.insert(photos).values({ atUri: "at://did:plc:other/c/1", mediaIndex: 0, did: "did:plc:other", source: "bsky", recordCid: "r", blobCid: "b", sortAt: new Date() });
    await expect(setHiddenForDid(db, "did:plc:k", "at://did:plc:other/c/1", 0, true)).rejects.toThrow(/not your photo/);
  });
  it("toggling bsky off deletes existing bsky rows but keeps luminance rows", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:k", handle: "k.photos", includeBsky: true, includeGrain: true });
    await db.insert(photos).values([
      { atUri: "at://did:plc:k/app.bsky.feed.post/1", mediaIndex: 0, did: "did:plc:k", source: "bsky", recordCid: "r", blobCid: "b1", sortAt: new Date() },
      { atUri: "at://did:plc:k/social.luminance.portfolio.photo/1", mediaIndex: 0, did: "did:plc:k", source: "luminance", recordCid: "r", blobCid: "b2", sortAt: new Date() },
    ]);
    await updateSourceToggles(db, "did:plc:k", { includeBsky: false, includeGrain: true });
    const rows = await db.select().from(photos);
    expect(rows.map((r) => r.source)).toEqual(["luminance"]);
    const [p] = await db.select().from(photographers);
    expect(p.includeBsky).toBe(false);
    expect(p.backfillStatus).toBe("pending");
  });
  it("toggling grain off deletes grain photos plus grain gallery series and their memberships", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:k", handle: "k.photos", includeBsky: true, includeGrain: true });
    const galleryUri = "at://did:plc:k/social.grain.gallery/g1";
    const lumSeriesUri = "at://did:plc:k/social.luminance.portfolio.series/s1";
    await db.insert(photos).values([
      { atUri: "at://did:plc:k/social.grain.photo/1", mediaIndex: 0, did: "did:plc:k", source: "grain", recordCid: "r", blobCid: "b1", sortAt: new Date() },
      { atUri: "at://did:plc:k/social.luminance.portfolio.photo/1", mediaIndex: 0, did: "did:plc:k", source: "luminance", recordCid: "r", blobCid: "b2", sortAt: new Date() },
    ]);
    await db.insert(series).values([
      { atUri: galleryUri, did: "did:plc:k", title: "Grain gallery" },
      { atUri: lumSeriesUri, did: "did:plc:k", title: "Luminance series" },
    ]);
    await db.insert(seriesPhotos).values([
      { seriesUri: galleryUri, photoUri: "at://did:plc:k/social.grain.photo/1", position: 0 },
      { seriesUri: lumSeriesUri, photoUri: "at://did:plc:k/social.luminance.portfolio.photo/1", position: 0 },
    ]);
    await updateSourceToggles(db, "did:plc:k", { includeBsky: true, includeGrain: false });
    expect((await db.select().from(photos)).map((r) => r.source)).toEqual(["luminance"]);
    expect((await db.select().from(series)).map((r) => r.atUri)).toEqual([lumSeriesUri]);
    expect((await db.select().from(seriesPhotos)).map((r) => r.seriesUri)).toEqual([lumSeriesUri]);
  });
  it("updateSourceToggles never changes a pending_review photographer's status", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:k", handle: "k.photos", status: "pending_review" });
    await updateSourceToggles(db, "did:plc:k", { includeBsky: false, includeGrain: false });
    const [p] = await db.select().from(photographers);
    expect(p.status).toBe("pending_review");
    expect(p.backfillStatus).toBe("pending");
  });
  it("deregister removes index rows but keeps overrides", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:k", handle: "k.photos" });
    await db.insert(photos).values({ atUri: "at://did:plc:k/c/1", mediaIndex: 0, did: "did:plc:k", source: "luminance", recordCid: "r", blobCid: "b", sortAt: new Date() });
    await db.insert(photoOverrides).values({ atUri: "at://did:plc:k/c/1", mediaIndex: 0, hidden: true });
    await deregisterDid(db, "did:plc:k");
    expect(await db.select().from(photos)).toHaveLength(0);
    expect(await db.select().from(photoOverrides)).toHaveLength(1);
    expect((await db.select().from(photographers))[0].status).toBe("deregistered");
  });
});
