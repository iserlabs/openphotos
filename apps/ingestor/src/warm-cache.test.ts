import { describe, it, expect } from "vitest";
import { createTestDb, photos, photographers } from "@luminance/db";
import { warmNewPhotos } from "./warm-cache.js";

const DID = "did:plc:kevin";

describe("warmNewPhotos", () => {
  it("no base url -> no requests", async () => {
    const db = await createTestDb();
    const urls: string[] = [];
    const n = await warmNewPhotos(db, DID, { fetcher: async (u) => { urls.push(u); } });
    expect(n).toBe(0);
    expect(urls).toEqual([]);
  });

  it("warms thumb+feed for recently indexed rows of the did only", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "k.test" });
    await db.insert(photos).values([
      { atUri: `at://${DID}/app.bsky.feed.post/new`, mediaIndex: 0, did: DID, source: "bsky", recordCid: "r", blobCid: "bafk-new", sortAt: new Date() },
      { atUri: `at://did:plc:other/app.bsky.feed.post/x`, mediaIndex: 0, did: "did:plc:other", source: "bsky", recordCid: "r", blobCid: "bafk-other", sortAt: new Date() },
    ]);
    const urls: string[] = [];
    const n = await warmNewPhotos(db, DID, { baseUrl: "https://x.test", fetcher: async (u) => { urls.push(u); } });
    expect(n).toBe(2);
    expect(urls.some((u) => u.includes("bafk-new") && u.endsWith("/thumb"))).toBe(true);
    expect(urls.some((u) => u.includes("bafk-new") && u.endsWith("/feed"))).toBe(true);
    expect(urls.some((u) => u.includes("bafk-other"))).toBe(false);
  });

  it("a failing warm continues with the rest", async () => {
    const db = await createTestDb();
    await db.insert(photos).values([
      { atUri: `at://${DID}/app.bsky.feed.post/a`, mediaIndex: 0, did: DID, source: "bsky", recordCid: "r", blobCid: "bafk-a", sortAt: new Date() },
    ]);
    let calls = 0;
    const n = await warmNewPhotos(db, DID, { baseUrl: "https://x.test", fetcher: async () => { calls++; if (calls === 1) throw new Error("cold"); } });
    expect(calls).toBe(2);
    expect(n).toBe(1);
  });
});
