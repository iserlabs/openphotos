import { describe, it, expect } from "vitest";
import { mapBskyPost } from "./bsky.js";
import fourImg from "./fixtures/bsky-post-4img.json" with { type: "json" };
import reply from "./fixtures/bsky-post-reply.json" with { type: "json" };
import quote from "./fixtures/bsky-post-quote-media.json" with { type: "json" };

const ctx = { did: "did:plc:kevin", collection: "app.bsky.feed.post", rkey: "3xyz", cid: "bafyrec", indexedAt: new Date("2026-07-21T12:00:00Z") };
const uri = "at://did:plc:kevin/app.bsky.feed.post/3xyz";

describe("mapBskyPost", () => {
  it("maps one row per image with mediaIndex + shared groupKey", () => {
    const rows = mapBskyPost(ctx, fourImg);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.mediaIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(rows.map((r) => r.atUri))).toEqual(new Set([uri]));
    expect(rows.every((r) => r.groupKey === uri && r.source === "bsky")).toBe(true);
    expect(rows[0].caption).toBe(fourImg.text);
  });
  it("skips replies", () => expect(mapBskyPost(ctx, reply)).toEqual([]));
  it("skips quote-posts-with-media", () => expect(mapBskyPost(ctx, quote)).toEqual([]));
  it("skips posts without image embeds", () =>
    expect(mapBskyPost(ctx, { text: "hi", createdAt: "2026-01-01T00:00:00Z" })).toEqual([]));
});

import gallery from "./fixtures/bsky-post-gallery.json" with { type: "json" };

describe("mapBskyPost gallery embeds (app.bsky.embed.gallery)", () => {
  const gctx = { did: "did:plc:kevin", collection: "app.bsky.feed.post", rkey: "3mrap7bkyuc2t", cid: "bafyrec", indexedAt: new Date("2026-07-22T17:00:00Z") };
  const guri = "at://did:plc:kevin/app.bsky.feed.post/3mrap7bkyuc2t";
  it("maps one row per gallery item with mediaIndex + shared groupKey", () => {
    const rows = mapBskyPost(gctx, gallery);
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.mediaIndex)).toEqual([0,1,2,3,4,5,6,7,8,9]);
    expect(new Set(rows.map((r) => r.atUri))).toEqual(new Set([guri]));
    expect(rows.every((r) => r.groupKey === guri && r.source === "bsky")).toBe(true);
    expect(rows[0].blobCid).toBe("bafkreicaipajd77wf53szr6kojxyabjzxspkorgbzizbdlyzdaq6zuokd4");
    expect(rows[0].width).toBe(3400);
  });
});
