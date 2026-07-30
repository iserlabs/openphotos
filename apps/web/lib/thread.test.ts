import { describe, it, expect } from "vitest";
import type { ThreadView } from "@openphotos/atproto";
import { createTestDb, recordInteraction, softDeleteInteraction } from "@openphotos/db";
import { flattenThread, pendingOwnComments } from "./thread";
// Real, captured-from-AppView fixture (Task 3) — a post with zero replies.
// Reused here to confirm the (empty) real shape parses without special-casing.
import getPostThreadFixture from "../../../packages/atproto/src/fixtures/appview/getPostThread.json" with { type: "json" };

const AUTHOR_A = { did: "did:plc:aaa", handle: "alice.bsky.social", avatar: "https://cdn.bsky.app/img/a.jpg" };
const AUTHOR_B = { did: "did:plc:bbb", handle: "bob.bsky.social", avatar: "https://cdn.bsky.app/img/b.jpg" };
const AUTHOR_C = { did: "did:plc:ccc", handle: "carol.bsky.social", avatar: "https://cdn.bsky.app/img/c.jpg" };

/** Minimal well-formed `threadViewPost` reply node builder. */
function reply(opts: {
  uri: string;
  cid?: string;
  author?: typeof AUTHOR_A;
  text?: string;
  createdAt?: string;
  labels?: { val: string }[];
  replies?: unknown[];
}) {
  return {
    post: {
      uri: opts.uri,
      cid: opts.cid ?? "bafycid",
      author: opts.author ?? AUTHOR_A,
      record: { text: opts.text ?? "hello", createdAt: opts.createdAt ?? "2026-07-20T00:00:00.000Z" },
      labels: opts.labels ?? [],
      indexedAt: "2026-07-20T00:00:01.000Z",
    },
    replies: opts.replies ?? [],
  };
}

/** A blocked/hidden reply stub — no `.post`, no `.replies` (real AppView shape). */
function blockedStub(uri: string) {
  return { $type: "app.bsky.feed.defs#blockedPost", uri, blocked: true };
}

function threadWithReplies(replies: unknown[]): ThreadView {
  return {
    post: reply({ uri: "at://did:plc:root/app.bsky.feed.post/root" }).post,
    replies,
  } as unknown as ThreadView;
}

describe("flattenThread", () => {
  it("parses the real zero-reply AppView fixture to an empty array", () => {
    const thread = getPostThreadFixture.thread as unknown as ThreadView;
    expect(flattenThread(thread, { maxDepth: 2 })).toEqual([]);
  });

  it("flattens 2-level nesting without clipping", () => {
    const thread = threadWithReplies([
      reply({
        uri: "at://did:plc:aaa/app.bsky.feed.post/a",
        author: AUTHOR_A,
        text: "top-level comment",
        replies: [
          reply({
            uri: "at://did:plc:bbb/app.bsky.feed.post/b",
            author: AUTHOR_B,
            text: "a reply to the top-level comment",
          }),
        ],
      }),
    ]);

    const nodes = flattenThread(thread, { maxDepth: 2 });

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      uri: "at://did:plc:aaa/app.bsky.feed.post/a",
      authorDid: AUTHOR_A.did,
      authorHandle: AUTHOR_A.handle,
      depth: 0,
      hasMore: false,
    });
    expect(nodes[1]).toMatchObject({
      uri: "at://did:plc:bbb/app.bsky.feed.post/b",
      authorDid: AUTHOR_B.did,
      depth: 1,
      hasMore: false,
    });
  });

  it("clips a 3-level-deep thread at maxDepth 2, flagging the deepest included node hasMore", () => {
    const thread = threadWithReplies([
      reply({
        uri: "at://did:plc:aaa/app.bsky.feed.post/a",
        author: AUTHOR_A,
        replies: [
          reply({
            uri: "at://did:plc:bbb/app.bsky.feed.post/b",
            author: AUTHOR_B,
            replies: [
              reply({
                uri: "at://did:plc:ccc/app.bsky.feed.post/c",
                author: AUTHOR_C,
              }),
            ],
          }),
        ],
      }),
    ]);

    const nodes = flattenThread(thread, { maxDepth: 2 });

    // Only 2 levels come back — the 3rd-level reply (C) is dropped entirely.
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.uri)).toEqual([
      "at://did:plc:aaa/app.bsky.feed.post/a",
      "at://did:plc:bbb/app.bsky.feed.post/b",
    ]);
    expect(nodes[0].hasMore).toBe(false); // its child (B) DID make it into the output
    expect(nodes[1].hasMore).toBe(true); // B's own child (C) got clipped
  });

  it("skips blocked/notFound stub replies (render as absent) without throwing", () => {
    const thread = threadWithReplies([
      blockedStub("at://did:plc:blocked/app.bsky.feed.post/x"),
      reply({ uri: "at://did:plc:aaa/app.bsky.feed.post/a", author: AUTHOR_A, text: "survives" }),
    ]);

    expect(() => flattenThread(thread, { maxDepth: 2 })).not.toThrow();
    const nodes = flattenThread(thread, { maxDepth: 2 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].uri).toBe("at://did:plc:aaa/app.bsky.feed.post/a");
  });

  it("skips a blocked stub nested under a real reply, keeping the real reply itself", () => {
    const thread = threadWithReplies([
      reply({
        uri: "at://did:plc:aaa/app.bsky.feed.post/a",
        author: AUTHOR_A,
        replies: [blockedStub("at://did:plc:blocked/app.bsky.feed.post/y")],
      }),
    ]);

    const nodes = flattenThread(thread, { maxDepth: 2 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].uri).toBe("at://did:plc:aaa/app.bsky.feed.post/a");
    // The blocked child contributed no real replies, so it must not read as clipped.
    expect(nodes[0].hasMore).toBe(false);
  });

  it("does not flag hasMore when a cutoff-depth node's only children are blocked/notFound stubs", () => {
    // B sits at depth 1, the deepest included depth for maxDepth 2 — i.e. the
    // clipping boundary. B's only "replies" are a stub with no `.post`, so
    // there is no real content being clipped; hasMore must read false.
    const thread = threadWithReplies([
      reply({
        uri: "at://did:plc:aaa/app.bsky.feed.post/a",
        author: AUTHOR_A,
        replies: [
          reply({
            uri: "at://did:plc:bbb/app.bsky.feed.post/b",
            author: AUTHOR_B,
            replies: [blockedStub("at://did:plc:blocked/app.bsky.feed.post/z")],
          }),
        ],
      }),
    ]);

    const nodes = flattenThread(thread, { maxDepth: 2 });

    expect(nodes).toHaveLength(2);
    expect(nodes[1].uri).toBe("at://did:plc:bbb/app.bsky.feed.post/b");
    expect(nodes[1].hasMore).toBe(false);
  });

  it("flags hasMore when a cutoff-depth node has a real (non-stub) child clipped", () => {
    // Companion case to the stub-only test above: B at the same depth-1
    // cutoff, but its clipped child is a real reply (has `.post`) — hasMore
    // must read true.
    const thread = threadWithReplies([
      reply({
        uri: "at://did:plc:aaa/app.bsky.feed.post/a",
        author: AUTHOR_A,
        replies: [
          reply({
            uri: "at://did:plc:bbb/app.bsky.feed.post/b",
            author: AUTHOR_B,
            replies: [
              reply({ uri: "at://did:plc:ccc/app.bsky.feed.post/c", author: AUTHOR_C }),
            ],
          }),
        ],
      }),
    ]);

    const nodes = flattenThread(thread, { maxDepth: 2 });

    expect(nodes).toHaveLength(2);
    expect(nodes[1].uri).toBe("at://did:plc:bbb/app.bsky.feed.post/b");
    expect(nodes[1].hasMore).toBe(true);
  });

  it("carries a labeled reply's moderation/self labels as string[]", () => {
    const thread = threadWithReplies([
      reply({
        uri: "at://did:plc:aaa/app.bsky.feed.post/a",
        author: AUTHOR_A,
        labels: [{ val: "nudity" }, { val: "graphic-media" }],
      }),
    ]);

    const nodes = flattenThread(thread, { maxDepth: 2 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].labels).toEqual(["nudity", "graphic-media"]);
  });

  it("defaults an unlabeled reply to an empty labels array", () => {
    const thread = threadWithReplies([
      reply({ uri: "at://did:plc:aaa/app.bsky.feed.post/a", author: AUTHOR_A }),
    ]);

    const nodes = flattenThread(thread, { maxDepth: 2 });
    expect(nodes[0].labels).toEqual([]);
  });
});

describe("pendingOwnComments", () => {
  const ATURI = "at://did:plc:photog/app.bsky.feed.post/p1";
  const SESSION_DID = "did:plc:me";
  const HANDLE = "me.test";

  it("includes the session user's own un-deleted comment that isn't already in the thread", async () => {
    const db = await createTestDb();
    const uri = "at://did:plc:me/app.bsky.feed.post/c1";
    await recordInteraction(db, { recordUri: uri, actorDid: SESSION_DID, kind: "comment", subjectUri: ATURI, text: "pending!", recordCid: "bafyc1" });

    const nodes = await pendingOwnComments(db, SESSION_DID, HANDLE, ATURI, new Set());

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      uri,
      authorDid: SESSION_DID,
      authorHandle: HANDLE,
      text: "pending!",
      depth: 0,
      hasMore: false,
      labels: [],
    });
    expect(nodes[0].authorAvatarUrl).toBeUndefined();
  });

  it("excludes a comment already present in the thread (uri in existingUris)", async () => {
    const db = await createTestDb();
    const uri = "at://did:plc:me/app.bsky.feed.post/c2";
    await recordInteraction(db, { recordUri: uri, actorDid: SESSION_DID, kind: "comment", subjectUri: ATURI, text: "already shown" });

    const nodes = await pendingOwnComments(db, SESSION_DID, HANDLE, ATURI, new Set([uri]));
    expect(nodes).toHaveLength(0);
  });

  it("excludes a soft-deleted own comment", async () => {
    const db = await createTestDb();
    const uri = "at://did:plc:me/app.bsky.feed.post/c3";
    await recordInteraction(db, { recordUri: uri, actorDid: SESSION_DID, kind: "comment", subjectUri: ATURI, text: "deleted" });
    await softDeleteInteraction(db, uri);

    const nodes = await pendingOwnComments(db, SESSION_DID, HANDLE, ATURI, new Set());
    expect(nodes).toHaveLength(0);
  });

  it("excludes another actor's comment and non-comment kinds on the same subject", async () => {
    const db = await createTestDb();
    await recordInteraction(db, { recordUri: "at://did:plc:other/app.bsky.feed.post/x", actorDid: "did:plc:other", kind: "comment", subjectUri: ATURI, text: "not mine" });
    await recordInteraction(db, { recordUri: "at://did:plc:me/app.bsky.feed.like/y", actorDid: SESSION_DID, kind: "like", subjectUri: ATURI });

    const nodes = await pendingOwnComments(db, SESSION_DID, HANDLE, ATURI, new Set());
    expect(nodes).toHaveLength(0);
  });
});
