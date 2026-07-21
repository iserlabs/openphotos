import { describe, it, expect } from "vitest";
import { createTestDb, photographers, photoOverrides, photos } from "@luminance/db";
import { eq } from "drizzle-orm";
import { completeRegistration, setHiddenForDid, deregisterDid } from "./registration";

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
