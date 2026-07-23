import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, photographers, photos, engagement, interactions, notifications, recordInteraction } from "@luminance/db";
import type { PostView, ThreadView, LikeView, ActorView } from "@luminance/atproto";
import { runEngagementSweep, startEngagementSweep, sweepOnce, governedIntervalMs, isRateLimited, type EngagementAppView } from "./engagement-sweep.js";

const KEVIN = "did:plc:kevin";
const OTHER = "did:plc:other";

async function seedPhotographer(db: Awaited<ReturnType<typeof createTestDb>>, did: string, handle: string, status: "active" | "deregistered" | "pending_review" = "active") {
  await db.insert(photographers).values({ did, handle, status });
}

async function seedBskyPhoto(db: Awaited<ReturnType<typeof createTestDb>>, atUri: string, did: string) {
  await db.insert(photos).values({
    atUri, mediaIndex: 0, did, source: "bsky", recordCid: "bafyrec", blobCid: "bafyblob",
    sortAt: new Date("2026-07-01T00:00:00Z"),
  });
}

async function seedLuminancePhoto(db: Awaited<ReturnType<typeof createTestDb>>, atUri: string, did: string) {
  await db.insert(photos).values({
    atUri, mediaIndex: 0, did, source: "luminance", recordCid: "bafyrec", blobCid: "bafyblob",
    sortAt: new Date("2026-07-01T00:00:00Z"),
  });
}

const post = (uri: string, overrides: Partial<PostView> = {}): PostView => ({
  uri, cid: "bafycid",
  author: { did: KEVIN, handle: "kevin.photos" },
  record: { text: "hi" },
  likeCount: 0, replyCount: 0, repostCount: 0,
  indexedAt: "2026-07-23T00:00:00Z",
  ...overrides,
});

const actor = (did: string, handle: string, avatar?: string): ActorView => ({ did, handle, avatar });

/** Stub appview: records every call it receives; each method's behavior is
 * overridable per test (spec §5 test plan: "stub appview object with
 * recorded calls"). */
function makeStubAppView(overrides: Partial<{
  getPosts: (uris: string[]) => Promise<PostView[]>;
  getPostThread: (uri: string, depth?: number) => Promise<ThreadView>;
  getLikes: (uri: string, limit?: number) => Promise<LikeView[]>;
  getFollowers: (did: string, limit?: number) => Promise<ActorView[]>;
}> = {}) {
  const calls = {
    getPosts: [] as string[][],
    getPostThread: [] as string[],
    getLikes: [] as string[],
    getFollowers: [] as string[],
  };
  const appview: EngagementAppView = {
    async getPosts(uris) {
      calls.getPosts.push(uris);
      return overrides.getPosts ? overrides.getPosts(uris) : [];
    },
    async getPostThread(uri, depth = 10) {
      calls.getPostThread.push(uri);
      return overrides.getPostThread ? overrides.getPostThread(uri, depth) : { post: post(uri), replies: [] };
    },
    async getLikes(uri, limit = 100) {
      calls.getLikes.push(uri);
      return overrides.getLikes ? overrides.getLikes(uri, limit) : [];
    },
    async getFollowers(did, limit = 100) {
      calls.getFollowers.push(did);
      return overrides.getFollowers ? overrides.getFollowers(did, limit) : [];
    },
  };
  return { appview, calls };
}

describe("scope filtering", () => {
  it("scopes getPosts to DISTINCT bsky-source post URIs of active registered photographers only", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos", "active");
    await seedPhotographer(db, OTHER, "other.photos", "deregistered");
    const activeBsky = "at://did:plc:kevin/app.bsky.feed.post/p1";
    const deregisteredBsky = "at://did:plc:other/app.bsky.feed.post/p2";
    const luminanceOnly = "at://did:plc:kevin/social.luminance.portfolio.photo/p3";
    await seedBskyPhoto(db, activeBsky, KEVIN);
    await seedBskyPhoto(db, deregisteredBsky, OTHER);
    await seedLuminancePhoto(db, luminanceOnly, KEVIN);
    // second media row of the same multi-image post must not duplicate the URI
    await db.insert(photos).values({
      atUri: activeBsky, mediaIndex: 1, did: KEVIN, source: "bsky", recordCid: "bafyrec2", blobCid: "bafyblob2",
      sortAt: new Date("2026-07-01T00:00:00Z"),
    });

    const { appview, calls } = makeStubAppView();
    await runEngagementSweep(db, appview);

    expect(calls.getPosts).toHaveLength(1);
    expect(calls.getPosts[0]).toEqual([activeBsky]);
  });
});

describe("counts upsert", () => {
  it("upserts engagement counts from getPosts with fetchedAt=now", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const uri = "at://did:plc:kevin/app.bsky.feed.post/p1";
    await seedBskyPhoto(db, uri, KEVIN);

    const { appview } = makeStubAppView({
      getPosts: async () => [post(uri, { likeCount: 3, replyCount: 1, repostCount: 2 })],
    });
    const before = Date.now();
    await runEngagementSweep(db, appview);

    const [row] = await db.select().from(engagement).where(eq(engagement.postUri, uri));
    expect(row).toMatchObject({ postUri: uri, likeCount: 3, replyCount: 1, repostCount: 2 });
    expect(row.fetchedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("like rise -> notifications", () => {
  it("calls getLikes when likeCount rose and pushes a notification per liker; dedupes across a second sweep", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const uri = "at://did:plc:kevin/app.bsky.feed.post/p1";
    await seedBskyPhoto(db, uri, KEVIN);
    await db.insert(engagement).values({ postUri: uri, likeCount: 0, replyCount: 0, repostCount: 0, fetchedAt: new Date(Date.now() - 60_000) });

    const liker = actor("did:plc:liker", "liker.bsky.social", "https://cdn.bsky.app/liker.jpg");
    const { appview, calls } = makeStubAppView({
      getPosts: async () => [post(uri, { likeCount: 1 })],
      getLikes: async () => [{ actor: liker, createdAt: "2026-07-23T00:00:00Z", indexedAt: "2026-07-23T00:00:00Z" }],
    });

    await runEngagementSweep(db, appview);
    expect(calls.getLikes).toEqual([uri]);
    const rows = await db.select().from(notifications).where(eq(notifications.recipientDid, KEVIN));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "like", subjectUri: uri, linkUri: uri,
      actorDid: liker.did, actorHandle: liker.handle, actorAvatarUrl: liker.avatar,
    });

    // second sweep, same data (likeCount didn't rise further from stored 1 -> 1)
    await runEngagementSweep(db, appview);
    const rows2 = await db.select().from(notifications).where(eq(notifications.recipientDid, KEVIN));
    expect(rows2).toHaveLength(1); // no duplicate
  });

  it("treats a brand-new engagement row with counts>0 as a rise (backfill)", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const uri = "at://did:plc:kevin/app.bsky.feed.post/p1";
    await seedBskyPhoto(db, uri, KEVIN);
    // no prior engagement row at all

    const liker = actor("did:plc:liker", "liker.bsky.social");
    const { appview, calls } = makeStubAppView({
      getPosts: async () => [post(uri, { likeCount: 1 })],
      getLikes: async () => [{ actor: liker, createdAt: "2026-07-23T00:00:00Z", indexedAt: "2026-07-23T00:00:00Z" }],
    });
    await runEngagementSweep(db, appview);
    expect(calls.getLikes).toEqual([uri]);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("does not notify the photographer for a like on their own post", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const uri = "at://did:plc:kevin/app.bsky.feed.post/p1";
    await seedBskyPhoto(db, uri, KEVIN);

    const { appview } = makeStubAppView({
      getPosts: async () => [post(uri, { likeCount: 1 })],
      getLikes: async () => [{ actor: actor(KEVIN, "kevin.photos"), createdAt: "2026-07-23T00:00:00Z", indexedAt: "2026-07-23T00:00:00Z" }],
    });
    await runEngagementSweep(db, appview);
    expect(await db.select().from(notifications)).toHaveLength(0);
  });
});

describe("reply rise -> thread walk", () => {
  it("walks the thread and pushes one notification per new reply, including nested replies", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const uri = "at://did:plc:kevin/app.bsky.feed.post/p1";
    await seedBskyPhoto(db, uri, KEVIN);

    const replier1 = actor("did:plc:r1", "r1.bsky.social", "https://cdn.bsky.app/r1.jpg");
    const replier2 = actor("did:plc:r2", "r2.bsky.social");
    const thread: ThreadView = {
      post: post(uri, { replyCount: 2 }),
      replies: [
        {
          post: post(`${uri}-r1`, { author: replier1, record: { text: "x".repeat(200) } }),
          replies: [
            { post: post(`${uri}-r1-r2`, { author: replier2, record: { text: "nested reply" } }), replies: [] },
          ],
        },
      ],
    };
    const { appview, calls } = makeStubAppView({
      getPosts: async () => [post(uri, { replyCount: 2 })],
      getPostThread: async () => thread,
    });

    await runEngagementSweep(db, appview);
    expect(calls.getPostThread).toEqual([uri]);
    const rows = await db.select().from(notifications).where(eq(notifications.recipientDid, KEVIN));
    expect(rows).toHaveLength(2);
    const byActor = new Map(rows.map((r) => [r.actorDid, r]));
    expect(byActor.get(replier1.did)).toMatchObject({ kind: "comment", subjectUri: `${uri}-r1`, linkUri: uri, snippet: "x".repeat(140) });
    expect(byActor.get(replier2.did)).toMatchObject({ kind: "comment", subjectUri: `${uri}-r1-r2`, linkUri: uri, snippet: "nested reply" });
  });

  it("does not notify the photographer for their own reply", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const uri = "at://did:plc:kevin/app.bsky.feed.post/p1";
    await seedBskyPhoto(db, uri, KEVIN);

    const thread: ThreadView = {
      post: post(uri, { replyCount: 1 }),
      replies: [{ post: post(`${uri}-self`, { author: { did: KEVIN, handle: "kevin.photos" } }), replies: [] }],
    };
    const { appview } = makeStubAppView({
      getPosts: async () => [post(uri, { replyCount: 1 })],
      getPostThread: async () => thread,
    });
    await runEngagementSweep(db, appview);
    expect(await db.select().from(notifications)).toHaveLength(0);
  });
});

describe("follower diff", () => {
  it("only runs getFollowers when sweepIndex is divisible by 5", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");

    const { appview: appviewSkip, calls: callsSkip } = makeStubAppView();
    await runEngagementSweep(db, appviewSkip, { sweepIndex: 3 });
    expect(callsSkip.getFollowers).toHaveLength(0);

    const follower = actor("did:plc:follower", "follower.bsky.social", "https://cdn.bsky.app/f.jpg");
    const { appview: appviewRun, calls: callsRun } = makeStubAppView({ getFollowers: async () => [follower] });
    await runEngagementSweep(db, appviewRun, { sweepIndex: 5 });
    expect(callsRun.getFollowers).toEqual([KEVIN]);

    const rows = await db.select().from(notifications).where(eq(notifications.recipientDid, KEVIN));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "follow", subjectUri: KEVIN, linkUri: "/kevin.photos",
      actorDid: follower.did, actorHandle: follower.handle, actorAvatarUrl: follower.avatar,
    });
  });

  it("runs on sweepIndex 0 too", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const { appview, calls } = makeStubAppView();
    await runEngagementSweep(db, appview, { sweepIndex: 0 });
    expect(calls.getFollowers).toEqual([KEVIN]);
  });
});

describe("429 handling", () => {
  it("aborts the tick cleanly on a 429, keeping rows already upserted; resumes on the next call", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const uriA = "at://did:plc:kevin/app.bsky.feed.post/pa";
    const uriB = "at://did:plc:kevin/app.bsky.feed.post/pb";
    await seedBskyPhoto(db, uriA, KEVIN);
    await seedBskyPhoto(db, uriB, KEVIN);

    let getLikesCalls = 0;
    const { appview } = makeStubAppView({
      getPosts: async () => [post(uriA, { likeCount: 1 }), post(uriB, { likeCount: 1 })],
      getLikes: async () => {
        getLikesCalls++;
        // post A's getLikes succeeds (and its engagement row is already
        // upserted by then); post B's engagement row is upserted before ITS
        // getLikes call, which is the one that 429s — proving both rows
        // persist independently of the abort.
        if (getLikesCalls === 2) throw new Error("fetch https://public.api.bsky.app/xrpc/app.bsky.feed.getLikes: 429");
        return [];
      },
    });

    await expect(runEngagementSweep(db, appview)).resolves.toBeUndefined(); // aborts cleanly, does not throw

    // Both posts' engagement rows were upserted before the per-post getLikes
    // call for that same post — independent of the abort on the first one.
    const rows = await db.select().from(engagement);
    expect(rows.map((r) => r.postUri).sort()).toEqual([uriA, uriB].sort());

    // Next run resumes cleanly (no leftover corruption).
    getLikesCalls = 0;
    await expect(runEngagementSweep(db, appview)).resolves.toBeUndefined();
  });

  it("isRateLimited recognizes safeJsonFetch's status-in-message shape and explicit status codes", () => {
    expect(isRateLimited(new Error("fetch https://x: 429"))).toBe(true);
    expect(isRateLimited(new Error("fetch https://x: 500"))).toBe(false);
    expect(isRateLimited({ status: 429 })).toBe(true);
    expect(isRateLimited({ statusCode: 429 })).toBe(true);
    expect(isRateLimited(null)).toBe(false);
  });
});

describe("prune", () => {
  it("removes a soft-deleted interaction older than its subject's engagement.fetchedAt, keeps a newer one", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const uriAbsorbed = "at://did:plc:kevin/app.bsky.feed.post/pabsorbed";
    const uriPending = "at://did:plc:kevin/app.bsky.feed.post/ppending";
    const uriNoEngagement = "at://did:plc:kevin/app.bsky.feed.post/pnone";

    await db.insert(engagement).values({ postUri: uriAbsorbed, fetchedAt: new Date() });
    await db.insert(engagement).values({ postUri: uriPending, fetchedAt: new Date(Date.now() - 60_000) });
    // uriNoEngagement intentionally has no engagement row

    await recordInteraction(db, { recordUri: "at://did:plc:v/app.bsky.feed.like/absorbed", actorDid: "did:plc:v", kind: "like", subjectUri: uriAbsorbed });
    await db.update(interactions).set({ deletedAt: new Date(Date.now() - 120_000) }).where(eq(interactions.recordUri, "at://did:plc:v/app.bsky.feed.like/absorbed"));

    await recordInteraction(db, { recordUri: "at://did:plc:v/app.bsky.feed.like/pending", actorDid: "did:plc:v", kind: "like", subjectUri: uriPending });
    await db.update(interactions).set({ deletedAt: new Date() }).where(eq(interactions.recordUri, "at://did:plc:v/app.bsky.feed.like/pending"));

    await recordInteraction(db, { recordUri: "at://did:plc:v/app.bsky.feed.like/nosubject", actorDid: "did:plc:v", kind: "like", subjectUri: uriNoEngagement });
    await db.update(interactions).set({ deletedAt: new Date(Date.now() - 120_000) }).where(eq(interactions.recordUri, "at://did:plc:v/app.bsky.feed.like/nosubject"));

    const { appview } = makeStubAppView();
    await runEngagementSweep(db, appview);

    const remaining = await db.select({ recordUri: interactions.recordUri }).from(interactions);
    const remainingUris = remaining.map((r) => r.recordUri).sort();
    expect(remainingUris).toEqual([
      "at://did:plc:v/app.bsky.feed.like/nosubject", // no engagement row -> left alone
      "at://did:plc:v/app.bsky.feed.like/pending",   // deletedAt > fetchedAt -> not yet absorbed
    ].sort());
  });
});

describe("staleness", () => {
  it("logs engagement_staleness_seconds when the oldest in-scope fetchedAt exceeds 30 minutes", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const uri = "at://did:plc:kevin/app.bsky.feed.post/p1";
    await seedBskyPhoto(db, uri, KEVIN);
    await db.insert(engagement).values({ postUri: uri, fetchedAt: new Date(Date.now() - 31 * 60_000) });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { appview } = makeStubAppView({ getPosts: async () => [post(uri)] });
    await runEngagementSweep(db, appview);
    expect(errSpy.mock.calls.some((c) => String(c[0]).startsWith("engagement_staleness_seconds="))).toBe(true);
    errSpy.mockRestore();
  });

  it("does not log staleness when fetchedAt is recent", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const uri = "at://did:plc:kevin/app.bsky.feed.post/p1";
    await seedBskyPhoto(db, uri, KEVIN);
    await db.insert(engagement).values({ postUri: uri, fetchedAt: new Date() });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { appview } = makeStubAppView({ getPosts: async () => [post(uri)] });
    await runEngagementSweep(db, appview);
    expect(errSpy.mock.calls.some((c) => String(c[0]).startsWith("engagement_staleness_seconds="))).toBe(false);
    errSpy.mockRestore();
  });
});

describe("governor math", () => {
  it("holds the 3-min base interval at alpha scale (~200 posts, low rises)", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const uris: string[] = [];
    for (let i = 0; i < 200; i++) {
      const uri = `at://did:plc:kevin/app.bsky.feed.post/p${i}`;
      uris.push(uri);
      await seedBskyPhoto(db, uri, KEVIN);
    }
    const { appview } = makeStubAppView({ getPosts: async (u) => u.map((uri) => post(uri)) });
    const result = await sweepOnce(db, appview, { sweepIndex: 1 }); // skip follower diff to isolate post math
    // ceil(200/25) = 8 requests -> well under the 240/min budget -> base interval holds
    expect(result.requestsPerSweep).toBe(8);
    expect(result.intervalMs).toBe(180_000);
  });

  it("stretches the interval for a contrived large request count", () => {
    expect(governedIntervalMs(10_000)).toBe(Math.ceil((10_000 / 240) * 60_000));
    expect(governedIntervalMs(10_000)).toBeGreaterThan(180_000);
    expect(governedIntervalMs(0)).toBe(180_000);
  });

  it("logs the engagement_sweep line with interval_ms and requests", async () => {
    const db = await createTestDb();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { appview } = makeStubAppView();
    await runEngagementSweep(db, appview);
    expect(logSpy.mock.calls.some((c) => /^engagement_sweep interval_ms=\d+ requests=\d+$/.test(String(c[0])))).toBe(true);
    logSpy.mockRestore();
  });
});

describe("startEngagementSweep", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not call the appview before the base interval elapses, and stop() prevents any tick", async () => {
    const db = await createTestDb();
    const { appview, calls } = makeStubAppView();
    const stopper = startEngagementSweep(db, appview);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.getFollowers).toHaveLength(0);
    stopper.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls.getFollowers).toHaveLength(0);
  });

  it("ticks after the base interval and chains the next tick at the governed interval", async () => {
    const db = await createTestDb();
    await seedPhotographer(db, KEVIN, "kevin.photos");
    const { appview, calls } = makeStubAppView();
    const stopper = startEngagementSweep(db, appview);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(calls.getFollowers).toHaveLength(1); // sweepIndex 0 -> follower diff runs
    await vi.advanceTimersByTimeAsync(180_000);
    expect(calls.getFollowers).toHaveLength(1); // sweepIndex 1 -> skipped
    stopper.stop();
  });
});
