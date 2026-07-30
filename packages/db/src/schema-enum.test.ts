import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./test-db.js";
import { photos, photographers } from "./schema.js";

// Migration 0006 adds "opencontent" to the photo_source pgEnum via a lone
// `ALTER TYPE ... ADD VALUE`. On PG>=12 that's only transaction-safe when the
// new value is never read/written in the SAME transaction as the ALTER. This
// test proves the value is usable at all (i.e. the migration committed and
// the enum row is queryable long after, as it is here via createTestDb()
// running the real migrations folder) — not that it's safe mid-migration.
describe("photo_source enum: opencontent (migration 0006)", () => {
  it("accepts an insert with source \"opencontent\" and reads it back", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:oc", handle: "oc.example" });
    await db.insert(photos).values({
      atUri: "at://did:plc:oc/social.opencontent.photo/1",
      mediaIndex: 0,
      did: "did:plc:oc",
      source: "opencontent",
      recordCid: "rc1",
      blobCid: "b1",
      sortAt: new Date(2026, 0, 1),
    });
    const [row] = await db.select().from(photos).where(eq(photos.atUri, "at://did:plc:oc/social.opencontent.photo/1"));
    expect(row?.source).toBe("opencontent");
  });
});
