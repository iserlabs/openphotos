import { describe, it, expect } from "vitest";
import { createTestDb, photos, photographers } from "@luminance/db";
import { proxyImage } from "./image-proxy";

const seed = async (db: any) => {
  await db.insert(photographers).values({ did: "did:plc:a", handle: "klee.photos", avatarCid: "bafk-avatar" });
  await db.insert(photos).values({ atUri: "at://did:plc:a/c/1", mediaIndex: 0, did: "did:plc:a", source: "luminance", recordCid: "r", blobCid: "bafk-photo", sortAt: new Date() });
};

describe("image proxy", () => {
  it("404s for a blob the index does not reference — before any fetch", async () => {
    const db = await createTestDb(); await seed(db);
    let fetched = false;
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-unknown", preset: "feed", accept: "image/webp" },
      { fetchBlob: async () => { fetched = true; return Buffer.alloc(0); } });
    expect(res.status).toBe(404);
    expect(fetched).toBe(false);
  });
  it("400s on unknown preset", async () => {
    const db = await createTestDb(); await seed(db);
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-photo", preset: "original" as any, accept: "" });
    expect(res.status).toBe(400);
  });
  it("serves an allowlisted blob resized with immutable cache header", async () => {
    const db = await createTestDb(); await seed(db);
    const sharp = (await import("sharp")).default;
    const src = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: "#333" } }).jpeg().toBuffer();
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-photo", preset: "feed", accept: "image/webp" }, { fetchBlob: async () => src });
    expect(res.status).toBe(200);
    expect(res.cacheControl).toBe("public, max-age=31536000, immutable");
    const meta = await sharp(res.body!).metadata();
    expect(meta.width).toBe(1024);
  });
  it("502s with 30s negative cache when the PDS fetch fails", async () => {
    const db = await createTestDb(); await seed(db);
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-photo", preset: "feed", accept: "" }, { fetchBlob: async () => { throw new Error("pds down"); } });
    expect(res.status).toBe(502);
    expect(res.cacheControl).toBe("public, max-age=30");
  });
});
