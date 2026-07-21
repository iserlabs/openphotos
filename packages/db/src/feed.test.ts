import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./test-db.js";
import { photos, photographers, photoOverrides } from "./schema.js";
import { feedPage } from "./feed.js";
import type { Db } from "./client.js";

const p = (n: number, over: Partial<typeof photos.$inferInsert> = {}): typeof photos.$inferInsert => ({
  atUri: `at://did:plc:a/social.luminance.portfolio.photo/${n}`, mediaIndex: 0,
  did: "did:plc:a", source: "luminance", recordCid: "rc", blobCid: `b${n}`,
  sortAt: new Date(2026, 0, n), ...over,
});

describe("feedPage", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:a", handle: "klee.photos" });
  });
  it("returns newest-first with keyset cursor", async () => {
    await db.insert(photos).values([p(1), p(2), p(3)]);
    const page1 = await feedPage(db, { limit: 2 });
    expect(page1.items.map((i) => i.blobCid)).toEqual(["b3", "b2"]);
    const page2 = await feedPage(db, { limit: 2, cursor: page1.cursor! });
    expect(page2.items.map((i) => i.blobCid)).toEqual(["b1"]);
    expect(page2.cursor).toBeNull();
  });
  it("excludes hidden, takedown, and non-active photographers", async () => {
    await db.insert(photographers).values({ did: "did:plc:b", handle: "x.com", status: "deactivated" });
    await db.insert(photos).values([p(1), p(2), p(3, { atUri: "at://did:plc:b/c/3", did: "did:plc:b" })]);
    await db.insert(photoOverrides).values({ atUri: p(1).atUri, mediaIndex: 0, hidden: true });
    const page = await feedPage(db, { limit: 10 });
    expect(page.items.map((i) => i.blobCid)).toEqual(["b2"]);
  });
});
