import { describe, it, expect } from "vitest";
import { createTestDb, photos, photographers, photoOverrides } from "@openphotos/db";
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
  it("404s when a real blob CID is requested under a different DID (cross-DID leakage)", async () => {
    const db = await createTestDb(); await seed(db);
    await db.insert(photographers).values({ did: "did:plc:b", handle: "other.photos" });
    let fetched = false;
    const res = await proxyImage(db, { did: "did:plc:b", cid: "bafk-photo", preset: "feed", accept: "" },
      { fetchBlob: async () => { fetched = true; return Buffer.alloc(0); } });
    expect(res.status).toBe(404);
    expect(fetched).toBe(false);
  });
  it("400s on prototype-pollution preset (constructor)", async () => {
    const db = await createTestDb(); await seed(db);
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-photo", preset: "constructor" as any, accept: "" });
    expect(res.status).toBe(400);
  });
  it("404s a taken-down photo's blob before any fetch", async () => {
    const db = await createTestDb(); await seed(db);
    await db.insert(photoOverrides).values({ atUri: "at://did:plc:a/c/1", mediaIndex: 0, takedown: true });
    let fetched = false;
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-photo", preset: "feed", accept: "image/webp" },
      { fetchBlob: async () => { fetched = true; return Buffer.alloc(0); } });
    expect(res.status).toBe(404);
    expect(fetched).toBe(false);
  });
  it("populates blur_data_url on the first successful photo serve", async () => {
    const db = await createTestDb(); await seed(db);
    const sharp = (await import("sharp")).default;
    const src = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#a35" } }).jpeg().toBuffer();
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-photo", preset: "thumb", accept: "image/webp" }, { fetchBlob: async () => src });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(photos);
    expect(row.blurDataUrl).toMatch(/^data:image\/webp;base64,/);
    // Tiny by construction — inlined into every feed page, so keep it honest.
    expect(row.blurDataUrl!.length).toBeLessThan(1500);
    const meta = await sharp(Buffer.from(row.blurDataUrl!.split(",")[1], "base64")).metadata();
    expect(meta.width).toBe(16);
  });
  it("does not overwrite an existing blur_data_url", async () => {
    const db = await createTestDb(); await seed(db);
    await db.update(photos).set({ blurDataUrl: "data:image/webp;base64,SENTINEL" });
    const sharp = (await import("sharp")).default;
    const src = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#a35" } }).jpeg().toBuffer();
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-photo", preset: "thumb", accept: "" }, { fetchBlob: async () => src });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(photos);
    expect(row.blurDataUrl).toBe("data:image/webp;base64,SENTINEL");
  });
  it("serves an avatar without writing any blur_data_url", async () => {
    const db = await createTestDb(); await seed(db);
    const sharp = (await import("sharp")).default;
    const src = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#555" } }).jpeg().toBuffer();
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-avatar", preset: "thumb", accept: "" }, { fetchBlob: async () => src });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(photos);
    expect(row.blurDataUrl).toBeNull();
  });
  it("404s a deregistered photographer's avatar before any fetch", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:g", handle: "gone.photos", avatarCid: "bafk-gone-avatar", status: "deregistered" });
    let fetched = false;
    const res = await proxyImage(db, { did: "did:plc:g", cid: "bafk-gone-avatar", preset: "thumb", accept: "" },
      { fetchBlob: async () => { fetched = true; return Buffer.alloc(0); } });
    expect(res.status).toBe(404);
    expect(fetched).toBe(false);
  });
});
