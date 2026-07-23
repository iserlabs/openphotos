import { describe, it, expect } from "vitest";
import { buildLikeRecord, buildReplyRecord, buildFollowRecord, graphemeLength, COMMENT_MAX_GRAPHEMES } from "./interaction-records.js";

const post = { uri: "at://did:plc:a/app.bsky.feed.post/p1", cid: "bafyp1" };
const reply = { uri: "at://did:plc:b/app.bsky.feed.post/r1", cid: "bafyr1" };
const now = new Date("2026-07-23T00:00:00Z");

describe("builders", () => {
  it("like", () => expect(buildLikeRecord(post, now)).toEqual({ $type: "app.bsky.feed.like", subject: post, createdAt: now.toISOString() }));
  it("top-level comment: root === parent === post", () => {
    const r = buildReplyRecord("nice", post, post, now);
    expect(r).toEqual({ $type: "app.bsky.feed.post", text: "nice", reply: { root: post, parent: post }, createdAt: now.toISOString() });
  });
  it("nested comment: root is the post, parent is the comment", () => {
    expect(buildReplyRecord("agreed", post, reply, now).reply).toEqual({ root: post, parent: reply });
  });
  it("follow", () => expect(buildFollowRecord("did:plc:a", now)).toEqual({ $type: "app.bsky.graph.follow", subject: "did:plc:a", createdAt: now.toISOString() }));
  it("rejects empty and over-limit text", () => {
    expect(() => buildReplyRecord("", post, post, now)).toThrow();
    expect(() => buildReplyRecord("x".repeat(COMMENT_MAX_GRAPHEMES + 1), post, post, now)).toThrow();
  });
  it("graphemes not code units", () => expect(graphemeLength("👩‍👩‍👧‍👦❤️")).toBe(2));
});
