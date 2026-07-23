import { describe, it, expect, vi } from "vitest";
import type { Agent } from "@atproto/api";
import { createTestDb, photographers, interactions, notifications, type Db } from "@luminance/db";
import { COMMENT_MAX_GRAPHEMES } from "@luminance/atproto";
import {
  routeInteraction,
  likePhoto,
  unlikePhoto,
  commentOnPhoto,
  deleteOwnComment,
  followPhotographer,
  unfollowPhotographer,
  assertRateLimit,
  RateLimitError,
  RATE_LIMIT,
  type LikeSubject,
} from "./interactions";

const POST_URI = "at://did:plc:photographer/app.bsky.feed.post/p1";
const POST_CID = "bafypost1";
const VIEWER = "did:plc:viewer";
const PHOTOGRAPHER = "did:plc:photographer";

function makeSubject(overrides: Partial<LikeSubject> = {}): LikeSubject {
  return {
    uri: POST_URI,
    cid: POST_CID,
    photographerDid: PHOTOGRAPHER,
    photoLinkUri: POST_URI,
    actorHandle: "viewer.test",
    ...overrides,
  };
}

/** A fake `Agent` recording every `com.atproto.repo.*` call it receives. */
function makeFakeAgent(opts: {
  createRecord?: (input: unknown) => Promise<{ data: { uri: string; cid: string } }>;
  deleteRecord?: (input: unknown) => Promise<{ data: Record<string, never> }>;
  listRecords?: (input: unknown) => Promise<{ data: { cursor?: string; records: { uri: string; cid: string; value: unknown }[] } }>;
} = {}) {
  const createRecord = vi.fn(
    opts.createRecord ??
      (async () => ({ data: { uri: "at://did:plc:viewer/app.bsky.feed.like/l1", cid: "bafylike1" } })),
  );
  const deleteRecord = vi.fn(opts.deleteRecord ?? (async () => ({ data: {} })));
  const listRecords = vi.fn(opts.listRecords ?? (async () => ({ data: { records: [] } })));
  const agent = {
    com: { atproto: { repo: { createRecord, deleteRecord, listRecords } } },
  };
  return { agent: agent as unknown as Agent, createRecord, deleteRecord, listRecords };
}

/**
 * Wraps a real (PGlite-backed) test db so every `.insert(...)` call throws,
 * simulating a DB outage for the write-through half of a like/unlike — while
 * every other method (select, update, ...) still delegates to the real db.
 * Used to prove the record-first ordering contract: a PDS write that
 * succeeds followed by a DB write that fails must surface as `{ok:false}`,
 * never an uncaught throw.
 */
function withFailingInsert(db: Db): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "insert") {
        return () => {
          throw new Error("db unavailable");
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

describe("routeInteraction", () => {
  it("bsky photo is supported, subject carries uri+cid", () => {
    const routed = routeInteraction({ source: "bsky", atUri: POST_URI, recordCid: POST_CID });
    expect(routed).toEqual({ supported: true, subject: { uri: POST_URI, cid: POST_CID } });
  });
  it("luminance photo is not yet supported", () => {
    expect(routeInteraction({ source: "luminance", atUri: POST_URI, recordCid: POST_CID })).toEqual({
      supported: false,
    });
  });
  it("grain photo is not yet supported", () => {
    expect(routeInteraction({ source: "grain", atUri: POST_URI, recordCid: POST_CID })).toEqual({
      supported: false,
    });
  });
});

describe("likePhoto", () => {
  it("creates the record via the agent with the buildLikeRecord shape, then records the interaction keyed by the returned uri", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: PHOTOGRAPHER, handle: "photog.test" });
    const { agent, createRecord } = makeFakeAgent();

    const result = await likePhoto(db, async () => agent, VIEWER, makeSubject());

    expect(result).toEqual({ ok: true });
    expect(createRecord).toHaveBeenCalledWith({
      repo: VIEWER,
      collection: "app.bsky.feed.like",
      record: expect.objectContaining({ $type: "app.bsky.feed.like", subject: { uri: POST_URI, cid: POST_CID } }),
    });
    const rows = await db.select().from(interactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recordUri: "at://did:plc:viewer/app.bsky.feed.like/l1",
      actorDid: VIEWER,
      kind: "like",
      subjectUri: POST_URI,
    });
  });

  it("pushes a notification when the subject photographer is registered and is not the actor", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: PHOTOGRAPHER, handle: "photog.test" });
    const { agent } = makeFakeAgent();

    await likePhoto(db, async () => agent, VIEWER, makeSubject());

    const notifs = await db.select().from(notifications);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({
      recipientDid: PHOTOGRAPHER,
      actorDid: VIEWER,
      kind: "like",
      subjectUri: POST_URI,
      linkUri: POST_URI,
      snippet: null,
    });
  });

  it("does NOT push a notification when the actor likes their own photo", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: PHOTOGRAPHER, handle: "photog.test" });
    const { agent } = makeFakeAgent();

    // The photographer liking their own post.
    await likePhoto(db, async () => agent, PHOTOGRAPHER, makeSubject({ photographerDid: PHOTOGRAPHER }));

    expect(await db.select().from(notifications)).toHaveLength(0);
    // The interaction itself is still recorded.
    expect(await db.select().from(interactions)).toHaveLength(1);
  });

  it("records the interaction but skips the notification when the photographer is not registered", async () => {
    const db = await createTestDb();
    // No photographers row at all for PHOTOGRAPHER.
    const { agent } = makeFakeAgent();

    const result = await likePhoto(db, async () => agent, VIEWER, makeSubject());

    expect(result).toEqual({ ok: true });
    expect(await db.select().from(interactions)).toHaveLength(1);
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("rejects the 31st write within the rate-limit window", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: PHOTOGRAPHER, handle: "photog.test" });
    const rows = Array.from({ length: RATE_LIMIT.max }, (_, i) => ({
      recordUri: `at://did:plc:viewer/app.bsky.feed.like/seed${i}`,
      actorDid: VIEWER,
      kind: "like" as const,
      subjectUri: `${POST_URI}-${i}`,
    }));
    await db.insert(interactions).values(rows);
    const { agent, createRecord } = makeFakeAgent();

    await expect(likePhoto(db, async () => agent, VIEWER, makeSubject())).rejects.toThrow(RateLimitError);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it("counts soft-deleted rows toward the rate-limit window", async () => {
    const db = await createTestDb();
    const rows = Array.from({ length: RATE_LIMIT.max }, (_, i) => ({
      recordUri: `at://did:plc:viewer/app.bsky.feed.like/seed${i}`,
      actorDid: VIEWER,
      kind: "like" as const,
      subjectUri: `${POST_URI}-${i}`,
      deletedAt: new Date(),
    }));
    await db.insert(interactions).values(rows);

    await expect(assertRateLimit(db, VIEWER)).rejects.toThrow(RateLimitError);
  });

  it("allows a write when under the rate limit", async () => {
    const db = await createTestDb();
    await expect(assertRateLimit(db, VIEWER)).resolves.toBeUndefined();
  });

  it("self-heals a DB-half failure: PDS record created, DB write throws -> {ok:false}, no crash", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: PHOTOGRAPHER, handle: "photog.test" });
    const { agent, createRecord } = makeFakeAgent();
    const failingDb = withFailingInsert(db);

    const result = await likePhoto(failingDb, async () => agent, VIEWER, makeSubject());

    expect(result.ok).toBe(false);
    expect(createRecord).toHaveBeenCalledTimes(1); // the PDS write DID happen (record-first)
    // The real db (not the failing wrapper) confirms nothing was persisted.
    expect(await db.select().from(interactions)).toHaveLength(0);
  });
});

describe("unlikePhoto", () => {
  it("soft-deletes the stored interaction and calls deleteRecord with the parsed rkey", async () => {
    const db = await createTestDb();
    await db.insert(interactions).values({
      recordUri: "at://did:plc:viewer/app.bsky.feed.like/mylike1",
      actorDid: VIEWER,
      kind: "like",
      subjectUri: POST_URI,
    });
    const { agent, deleteRecord, listRecords } = makeFakeAgent();

    const result = await unlikePhoto(db, async () => agent, VIEWER, POST_URI);

    expect(result).toEqual({ ok: true });
    expect(deleteRecord).toHaveBeenCalledWith({ repo: VIEWER, collection: "app.bsky.feed.like", rkey: "mylike1" });
    expect(listRecords).not.toHaveBeenCalled();
    const [row] = await db.select().from(interactions);
    expect(row.deletedAt).not.toBeNull();
  });

  it("falls back to paging listRecords when no local row exists, finding the like on page 2", async () => {
    const db = await createTestDb();
    const page1 = { data: { cursor: "cursor1", records: [{ uri: "at://did:plc:viewer/app.bsky.feed.like/other", cid: "c", value: { subject: { uri: "at://other/post" } } }] } };
    const page2 = {
      data: {
        records: [
          { uri: "at://did:plc:viewer/app.bsky.feed.like/found2", cid: "c2", value: { subject: { uri: POST_URI } } },
        ],
      },
    };
    let call = 0;
    const listRecords = vi.fn(async () => (call++ === 0 ? page1 : page2));
    const { agent, deleteRecord } = makeFakeAgent({ listRecords });

    const result = await unlikePhoto(db, async () => agent, VIEWER, POST_URI);

    expect(result).toEqual({ ok: true });
    expect(listRecords).toHaveBeenCalledTimes(2);
    expect(deleteRecord).toHaveBeenCalledWith({ repo: VIEWER, collection: "app.bsky.feed.like", rkey: "found2" });
  });

  it("gives up gracefully after 10 pages of misses", async () => {
    const db = await createTestDb();
    let calls = 0;
    const listRecords = vi.fn(async () => {
      calls++;
      return { data: { cursor: `c${calls}`, records: [] } }; // always another page, never a match
    });
    const { agent, deleteRecord } = makeFakeAgent({ listRecords });

    const result = await unlikePhoto(db, async () => agent, VIEWER, POST_URI);

    expect(result).toEqual({ ok: false, error: "unlike in your Bluesky app" });
    expect(listRecords).toHaveBeenCalledTimes(10);
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it("falls back to paging when stored recordUri is unparseable", async () => {
    const db = await createTestDb();
    // Store an interaction with a garbage recordUri that can't be split
    await db.insert(interactions).values({
      recordUri: "invalid:garbage:format",
      actorDid: VIEWER,
      kind: "like",
      subjectUri: POST_URI,
    });
    const page1 = {
      data: {
        records: [
          { uri: "at://did:plc:viewer/app.bsky.feed.like/found1", cid: "c1", value: { subject: { uri: POST_URI } } },
        ],
      },
    };
    const { agent, deleteRecord, listRecords } = makeFakeAgent({ listRecords: async () => page1 });

    const result = await unlikePhoto(db, async () => agent, VIEWER, POST_URI);

    expect(result).toEqual({ ok: true });
    // Proves we paged instead of giving up
    expect(listRecords).toHaveBeenCalledTimes(1);
    expect(deleteRecord).toHaveBeenCalledWith({ repo: VIEWER, collection: "app.bsky.feed.like", rkey: "found1" });
  });
});

describe("commentOnPhoto", () => {
  it("top-level comment: root === parent === subject; interaction row keyed by the photo's post uri", async () => {
    const db = await createTestDb();
    const replyUri = "at://did:plc:viewer/app.bsky.feed.post/c1";
    const { agent, createRecord } = makeFakeAgent({
      createRecord: async () => ({ data: { uri: replyUri, cid: "bafyc1" } }),
    });

    const result = await commentOnPhoto(db, async () => agent, VIEWER, "viewer.test", {
      subject: { uri: POST_URI, cid: POST_CID },
      text: "nice shot",
      photographerDid: PHOTOGRAPHER,
      photoLinkUri: POST_URI,
    });

    expect(result).toEqual({ ok: true });
    expect(createRecord).toHaveBeenCalledWith({
      repo: VIEWER,
      collection: "app.bsky.feed.post",
      record: expect.objectContaining({
        $type: "app.bsky.feed.post",
        text: "nice shot",
        reply: { root: { uri: POST_URI, cid: POST_CID }, parent: { uri: POST_URI, cid: POST_CID } },
      }),
    });
    const rows = await db.select().from(interactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recordUri: replyUri,
      actorDid: VIEWER,
      kind: "comment",
      subjectUri: POST_URI,
      text: "nice shot",
    });
  });

  it("nested comment: root stays the photo's post, parent is the comment being replied to", async () => {
    const db = await createTestDb();
    const replyUri = "at://did:plc:viewer/app.bsky.feed.post/c2";
    const parent = { uri: "at://did:plc:other/app.bsky.feed.post/c1", cid: "bafyc1" };
    const { agent, createRecord } = makeFakeAgent({
      createRecord: async () => ({ data: { uri: replyUri, cid: "bafyc2" } }),
    });

    await commentOnPhoto(db, async () => agent, VIEWER, "viewer.test", {
      subject: { uri: POST_URI, cid: POST_CID },
      parent,
      text: "agreed",
      photographerDid: PHOTOGRAPHER,
      photoLinkUri: POST_URI,
    });

    expect(createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({ reply: { root: { uri: POST_URI, cid: POST_CID }, parent } }),
      }),
    );
    const [row] = await db.select().from(interactions);
    // The interactions row's subjectUri stays the PHOTO's root post uri, not the parent comment.
    expect(row.subjectUri).toBe(POST_URI);
  });

  it("pushes a notification keyed to the reply's own uri, with a 140-char snippet, when the photographer is registered and not the actor", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: PHOTOGRAPHER, handle: "photog.test" });
    const replyUri = "at://did:plc:viewer/app.bsky.feed.post/c3";
    const { agent } = makeFakeAgent({ createRecord: async () => ({ data: { uri: replyUri, cid: "bafyc3" } }) });
    const longText = "x".repeat(200);

    await commentOnPhoto(db, async () => agent, VIEWER, "viewer.test", {
      subject: { uri: POST_URI, cid: POST_CID },
      text: longText,
      photographerDid: PHOTOGRAPHER,
      photoLinkUri: POST_URI,
    });

    const notifs = await db.select().from(notifications);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({
      recipientDid: PHOTOGRAPHER,
      actorDid: VIEWER,
      kind: "comment",
      subjectUri: replyUri,
      linkUri: POST_URI,
      snippet: longText.slice(0, 140),
    });
  });

  it("does NOT push a notification when the actor comments on their own photo", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: PHOTOGRAPHER, handle: "photog.test" });
    const { agent } = makeFakeAgent({
      createRecord: async () => ({ data: { uri: "at://did:plc:photographer/app.bsky.feed.post/c4", cid: "bafyc4" } }),
    });

    await commentOnPhoto(db, async () => agent, PHOTOGRAPHER, "photog.test", {
      subject: { uri: POST_URI, cid: POST_CID },
      text: "my own photo",
      photographerDid: PHOTOGRAPHER,
      photoLinkUri: POST_URI,
    });

    expect(await db.select().from(notifications)).toHaveLength(0);
    expect(await db.select().from(interactions)).toHaveLength(1);
  });

  it("records the interaction but skips the notification when the photographer is not registered", async () => {
    const db = await createTestDb();
    const { agent } = makeFakeAgent({
      createRecord: async () => ({ data: { uri: "at://did:plc:viewer/app.bsky.feed.post/c5", cid: "bafyc5" } }),
    });

    const result = await commentOnPhoto(db, async () => agent, VIEWER, "viewer.test", {
      subject: { uri: POST_URI, cid: POST_CID },
      text: "great light",
      photographerDid: PHOTOGRAPHER,
      photoLinkUri: POST_URI,
    });

    expect(result).toEqual({ ok: true });
    expect(await db.select().from(interactions)).toHaveLength(1);
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("rejects text outside 1-300 graphemes as {ok:false} — never a throw — and never calls the agent", async () => {
    const db = await createTestDb();
    const { agent, createRecord } = makeFakeAgent();

    const result = await commentOnPhoto(db, async () => agent, VIEWER, "viewer.test", {
      subject: { uri: POST_URI, cid: POST_CID },
      text: "x".repeat(COMMENT_MAX_GRAPHEMES + 1),
      photographerDid: PHOTOGRAPHER,
      photoLinkUri: POST_URI,
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("1–300");
    expect(createRecord).not.toHaveBeenCalled();
  });

  it("rejects the 31st comment within the rate-limit window; createRecord never called", async () => {
    const db = await createTestDb();
    const rows = Array.from({ length: RATE_LIMIT.max }, (_, i) => ({
      recordUri: `at://did:plc:viewer/app.bsky.feed.post/seed${i}`,
      actorDid: VIEWER,
      kind: "comment" as const,
      subjectUri: `${POST_URI}-${i}`,
    }));
    await db.insert(interactions).values(rows);
    const { agent, createRecord } = makeFakeAgent();

    await expect(
      commentOnPhoto(db, async () => agent, VIEWER, "viewer.test", {
        subject: { uri: POST_URI, cid: POST_CID },
        text: "hello",
        photographerDid: PHOTOGRAPHER,
        photoLinkUri: POST_URI,
      }),
    ).rejects.toThrow(RateLimitError);
    expect(createRecord).not.toHaveBeenCalled();
  });
});

describe("deleteOwnComment", () => {
  it("soft-deletes the interaction and calls deleteRecord with the parsed collection+rkey", async () => {
    const db = await createTestDb();
    const recordUri = "at://did:plc:viewer/app.bsky.feed.post/mycomment1";
    await db.insert(interactions).values({ recordUri, actorDid: VIEWER, kind: "comment", subjectUri: POST_URI, text: "hi" });
    const { agent, deleteRecord } = makeFakeAgent();

    const result = await deleteOwnComment(db, async () => agent, VIEWER, recordUri);

    expect(result).toEqual({ ok: true });
    expect(deleteRecord).toHaveBeenCalledWith({ repo: VIEWER, collection: "app.bsky.feed.post", rkey: "mycomment1" });
    const [row] = await db.select().from(interactions);
    expect(row.deletedAt).not.toBeNull();
  });

  it("rejects a recordUri belonging to a different actor, never touching the agent factory", async () => {
    const db = await createTestDb();
    const foreignUri = "at://did:plc:someoneelse/app.bsky.feed.post/c9";
    const agentFactory = vi.fn(async () => {
      throw new Error("agentFactory should not be called for a foreign recordUri");
    });

    const result = await deleteOwnComment(db, agentFactory, VIEWER, foreignUri);

    expect(result.ok).toBe(false);
    expect(agentFactory).not.toHaveBeenCalled();
  });

  it("rejects a non-comment collection (own profile record) BEFORE any deleteRecord", async () => {
    // The uri is owned by the actor (passes the ownership check) but points at
    // their own app.bsky.actor.profile/self — deleting it would nuke the
    // viewer's profile. The collection guard must reject it as not-a-comment.
    const db = await createTestDb();
    const profileUri = `at://${VIEWER}/app.bsky.actor.profile/self`;
    const { agent, deleteRecord } = makeFakeAgent();

    const result = await deleteOwnComment(db, async () => agent, VIEWER, profileUri);

    expect(result.ok).toBe(false);
    expect(deleteRecord).not.toHaveBeenCalled();
  });
});

describe("followPhotographer", () => {
  it("creates the follow record via the agent, then records the interaction keyed by the returned uri", async () => {
    const db = await createTestDb();
    const followUri = "at://did:plc:viewer/app.bsky.graph.follow/f1";
    const { agent, createRecord } = makeFakeAgent({
      createRecord: async () => ({ data: { uri: followUri, cid: "bafyf1" } }),
    });

    const result = await followPhotographer(db, async () => agent, VIEWER, "viewer.test", {
      photographerDid: PHOTOGRAPHER,
    });

    expect(result).toEqual({ ok: true });
    expect(createRecord).toHaveBeenCalledWith({
      repo: VIEWER,
      collection: "app.bsky.graph.follow",
      record: expect.objectContaining({ $type: "app.bsky.graph.follow", subject: PHOTOGRAPHER }),
    });
    const [row] = await db.select().from(interactions);
    expect(row).toMatchObject({ recordUri: followUri, actorDid: VIEWER, kind: "follow", subjectUri: PHOTOGRAPHER });
  });

  it("pushes a notification with linkUri = /handle, when the photographer is registered and not the actor", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: PHOTOGRAPHER, handle: "photog.test" });
    const { agent } = makeFakeAgent({
      createRecord: async () => ({ data: { uri: "at://did:plc:viewer/app.bsky.graph.follow/f2", cid: "bafyf2" } }),
    });

    await followPhotographer(db, async () => agent, VIEWER, "viewer.test", {
      photographerDid: PHOTOGRAPHER,
    });

    const [notif] = await db.select().from(notifications);
    expect(notif).toMatchObject({
      recipientDid: PHOTOGRAPHER,
      actorDid: VIEWER,
      kind: "follow",
      subjectUri: PHOTOGRAPHER,
      linkUri: "/photog.test",
    });
  });

  it("does NOT push a notification when following unregistered photographer, but still records the interaction", async () => {
    const db = await createTestDb();
    const { agent } = makeFakeAgent({
      createRecord: async () => ({ data: { uri: "at://did:plc:viewer/app.bsky.graph.follow/f3", cid: "bafyf3" } }),
    });

    const result = await followPhotographer(db, async () => agent, VIEWER, "viewer.test", {
      photographerDid: PHOTOGRAPHER,
    });

    expect(result).toEqual({ ok: true });
    expect(await db.select().from(interactions)).toHaveLength(1);
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("rejects the 31st follow within the rate-limit window; createRecord never called", async () => {
    const db = await createTestDb();
    const rows = Array.from({ length: RATE_LIMIT.max }, (_, i) => ({
      recordUri: `at://did:plc:viewer/app.bsky.graph.follow/seed${i}`,
      actorDid: VIEWER,
      kind: "follow" as const,
      subjectUri: `did:plc:photog${i}`,
    }));
    await db.insert(interactions).values(rows);
    const { agent, createRecord } = makeFakeAgent();

    await expect(
      followPhotographer(db, async () => agent, VIEWER, "viewer.test", {
        photographerDid: PHOTOGRAPHER,
      }),
    ).rejects.toThrow(RateLimitError);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it("linkUri always uses the DB row's handle, never a client-supplied value on the target", async () => {
    const db = await createTestDb();
    // The DB's handle is the source of truth ...
    await db.insert(photographers).values({ did: PHOTOGRAPHER, handle: "dbhandle.test" });
    const { agent } = makeFakeAgent({
      createRecord: async () => ({ data: { uri: "at://did:plc:viewer/app.bsky.graph.follow/f9", cid: "bafyf9" } }),
    });

    // ... even if some caller (a stale form field, a parallel task's UI) manages
    // to smuggle a *different* handle onto the target object. Built without a
    // type annotation so TS's excess-property check doesn't block the extra
    // field — this simulates a caller bypassing the (narrowed) FollowTarget type.
    const targetWithStaleClientHandle = {
      photographerDid: PHOTOGRAPHER,
      photographerHandle: "client-stale.test",
    };

    await followPhotographer(db, async () => agent, VIEWER, "viewer.test", targetWithStaleClientHandle);

    const [notif] = await db.select().from(notifications);
    expect(notif.linkUri).toBe("/dbhandle.test");
  });

  it("re-following after an unfollow does not duplicate the notification row (dedupe key covers it)", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: PHOTOGRAPHER, handle: "photog.test" });
    let n = 0;
    const { agent } = makeFakeAgent({
      createRecord: async () => {
        n++;
        return { data: { uri: `at://did:plc:viewer/app.bsky.graph.follow/f${n}`, cid: `bafyf${n}` } };
      },
    });

    await followPhotographer(db, async () => agent, VIEWER, "viewer.test", {
      photographerDid: PHOTOGRAPHER,
    });
    await unfollowPhotographer(db, async () => agent, VIEWER, PHOTOGRAPHER);
    await followPhotographer(db, async () => agent, VIEWER, "viewer.test", {
      photographerDid: PHOTOGRAPHER,
    });

    const notifs = await db.select().from(notifications);
    expect(notifs).toHaveLength(1); // onConflictDoNothing — no duplicate across unfollow/refollow
  });
});

describe("unfollowPhotographer", () => {
  it("soft-deletes the interaction and calls deleteRecord with the parsed rkey", async () => {
    const db = await createTestDb();
    await db.insert(interactions).values({
      recordUri: "at://did:plc:viewer/app.bsky.graph.follow/f1",
      actorDid: VIEWER,
      kind: "follow",
      subjectUri: PHOTOGRAPHER,
    });
    const { agent, deleteRecord } = makeFakeAgent();

    const result = await unfollowPhotographer(db, async () => agent, VIEWER, PHOTOGRAPHER);

    expect(result).toEqual({ ok: true });
    expect(deleteRecord).toHaveBeenCalledWith({ repo: VIEWER, collection: "app.bsky.graph.follow", rkey: "f1" });
    const [row] = await db.select().from(interactions);
    expect(row.deletedAt).not.toBeNull();
  });

  it("returns {ok:false} with NO paging fallback when no interaction row exists", async () => {
    const db = await createTestDb();
    const { agent, deleteRecord, listRecords } = makeFakeAgent();

    const result = await unfollowPhotographer(db, async () => agent, VIEWER, PHOTOGRAPHER);

    expect(result).toEqual({ ok: false, error: "unfollow in your Bluesky app" });
    expect(listRecords).not.toHaveBeenCalled();
    expect(deleteRecord).not.toHaveBeenCalled();
  });
});
