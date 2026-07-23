import { describe, it, expect } from "vitest";
import {
  buildLikeRecord,
  buildReplyRecord,
  buildFollowRecord,
  graphemeLength,
  graphemeSlice,
  COMMENT_MAX_GRAPHEMES,
} from "./interaction-records.js";

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

// A high surrogate not followed by its low-surrogate partner, or a low
// surrogate not preceded by its high-surrogate partner — i.e. a genuinely
// *unpaired* surrogate. (Plain `/[\uD800-\uDFFF]/` alone can't distinguish
// this from a complete, validly-paired emoji, which also contains code units
// in that range — it would false-positive on any string that legitimately
// kept a whole emoji.)
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("graphemeSlice", () => {
  it("cuts at a grapheme boundary, never leaving a lone surrogate — where .slice would", () => {
    // Every 😀 is a surrogate pair (2 UTF-16 code units); the leading "a" shifts
    // the code-unit parity so a naive .slice(0, 140) lands mid-pair.
    const s = "a" + "😀".repeat(145);
    const naive = s.slice(0, 140);

    // Prove the naive approach really does break first — this is the bug being
    // fixed: a lone (unpaired) high surrogate dangling at the very end.
    expect(/[\uD800-\uDFFF]/.test(naive)).toBe(true);
    expect(LONE_SURROGATE.test(naive)).toBe(true);

    // graphemeSlice, cutting on grapheme boundaries, never lands mid-character —
    // whatever it keeps is always whole, complete grapheme clusters, so the
    // result never contains a lone surrogate (it may still legitimately
    // contain *complete*, validly-paired surrogates from whole emoji it kept —
    // that's fine; only an unpaired half would corrupt the string).
    const safe = graphemeSlice(s, 140);
    expect(LONE_SURROGATE.test(safe)).toBe(false);
  });

  it("takes the first n grapheme clusters, not n code units", () => {
    expect(graphemeSlice("abcdef", 3)).toBe("abc");
    expect(graphemeSlice("👩‍👩‍👧‍👦❤️extra", 1)).toBe("👩‍👩‍👧‍👦");
  });

  it("returns the whole string when n exceeds its grapheme length", () => {
    expect(graphemeSlice("hi", 10)).toBe("hi");
  });
});
