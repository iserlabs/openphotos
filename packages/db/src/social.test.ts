import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./test-db.js";
import { engagement, interactions } from "./schema.js";
import { engagementFor, recordInteraction, softDeleteInteraction, findInteraction, interactionWritesInWindow, pushNotification, unreadCount, notificationsPage, markAllRead, markRead } from "./social.js";

const POST = "at://did:plc:a/app.bsky.feed.post/p1";
const like = (n: number) => ({ recordUri: `at://did:plc:v/app.bsky.feed.like/l${n}`, actorDid: "did:plc:v", kind: "like" as const, subjectUri: POST });

describe("count formula (spec §3 races)", () => {
  it("adds local likes newer than fetchedAt", async () => {
    const db = await createTestDb();
    await db.insert(engagement).values({ postUri: POST, likeCount: 5, fetchedAt: new Date(Date.now() - 60_000) });
    await recordInteraction(db, like(1)); // created now > fetchedAt
    expect((await engagementFor(db, [POST])).get(POST)).toEqual({ likeCount: 6, replyCount: 0 });
  });
  // "Absorbed" now means BEYOND the 90s grace window: these fixtures are
  // anchored to minutes (createdAt ~now-10min, fetchedAt ~now-5min) so the
  // like/unlike sit safely older than `fetchedAt - ABSORPTION_GRACE_MS` — a
  // sub-grace offset (−5s/−10s) would count as unabsorbed under never-regress.
  it("does NOT double-count a like the sweep already absorbed", async () => {
    const db = await createTestDb();
    await db.insert(interactions).values({ ...like(1), createdAt: new Date(Date.now() - 10 * 60_000) });
    await db.insert(engagement).values({ postUri: POST, likeCount: 6, fetchedAt: new Date(Date.now() - 5 * 60_000) }); // sweep well after the like
    expect((await engagementFor(db, [POST])).get(POST)!.likeCount).toBe(6);
  });
  it("subtracts an unlike of an absorbed like", async () => {
    const db = await createTestDb();
    await db.insert(interactions).values({ ...like(1), createdAt: new Date(Date.now() - 10 * 60_000) });
    await db.insert(engagement).values({ postUri: POST, likeCount: 6, fetchedAt: new Date(Date.now() - 5 * 60_000) });
    await softDeleteInteraction(db, like(1).recordUri); // deletedAt (real now) > fetchedAt - grace
    expect((await engagementFor(db, [POST])).get(POST)!.likeCount).toBe(5);
  });
  it("does not subtract an unlike the sweep already absorbed (c<f, d<f, both beyond grace)", async () => {
    const db = await createTestDb();
    await db.insert(interactions).values({ ...like(1), createdAt: new Date(Date.now() - 10 * 60_000) });
    await db.update(interactions).set({ deletedAt: new Date(Date.now() - 8 * 60_000) }).where(eq(interactions.recordUri, like(1).recordUri));
    await db.insert(engagement).values({ postUri: POST, likeCount: 5, fetchedAt: new Date(Date.now() - 5 * 60_000) });
    expect((await engagementFor(db, [POST])).get(POST)!.likeCount).toBe(5);
  });
  it("never-regress: a like within grace of an absorbing sweep keeps its +1 (may briefly double, must not drop)", async () => {
    // The viewer liked ~30s ago; a sweep then fetched counts whose fetchedAt is
    // ~10s ago (20s after the like — INSIDE the 90s grace) but had NOT yet
    // absorbed the like (cached likeCount still 5). Pre-sweep, the display was
    // 5 + this pending like = 6. The sweep must NOT drop it back to 5.
    const db = await createTestDb();
    await db.insert(interactions).values({ ...like(1), createdAt: new Date(Date.now() - 30_000) });
    await db.insert(engagement).values({ postUri: POST, likeCount: 5, fetchedAt: new Date(Date.now() - 10_000) });
    expect((await engagementFor(db, [POST])).get(POST)!.likeCount).toBe(6); // not 5 — never regress
  });
  it("clamps at 0: cached 0 + a still-pending unlike must not go negative", async () => {
    // The like itself is long absorbed (createdAt beyond grace), cached count is
    // 0, but the unlike is recent (deletedAt within grace -> unabsorbed -1).
    // 0 - 1 would be -1; the final count clamps to 0.
    const db = await createTestDb();
    await db.insert(interactions).values({ ...like(1), createdAt: new Date(Date.now() - 10 * 60_000) });
    await db.update(interactions).set({ deletedAt: new Date() }).where(eq(interactions.recordUri, like(1).recordUri));
    await db.insert(engagement).values({ postUri: POST, likeCount: 0, fetchedAt: new Date(Date.now() - 5_000) });
    expect((await engagementFor(db, [POST])).get(POST)!.likeCount).toBe(0);
  });
  it("like+unlike both pending nets to zero delta", async () => {
    const db = await createTestDb();
    await db.insert(engagement).values({ postUri: POST, likeCount: 5, fetchedAt: new Date(Date.now() - 60_000) });
    await recordInteraction(db, like(1));
    await softDeleteInteraction(db, like(1).recordUri);
    expect((await engagementFor(db, [POST])).get(POST)!.likeCount).toBe(5);
  });
  it("returns zeros for posts with no engagement row", async () => {
    const db = await createTestDb();
    expect((await engagementFor(db, [POST])).get(POST)).toEqual({ likeCount: 0, replyCount: 0 });
  });
});

describe("interactions helpers", () => {
  it("findInteraction excludes soft-deleted; window count includes them", async () => {
    const db = await createTestDb();
    await recordInteraction(db, like(1));
    await softDeleteInteraction(db, like(1).recordUri);
    expect(await findInteraction(db, "did:plc:v", "like", POST)).toBeNull();
    expect(await interactionWritesInWindow(db, "did:plc:v", 300_000)).toBe(1);
  });
});

describe("notifications", () => {
  const notif = { recipientDid: "did:plc:a", actorDid: "did:plc:v", actorHandle: "v.test", kind: "like" as const, subjectUri: POST, linkUri: POST };
  it("dedupes on (kind, subject, actor, recipient)", async () => {
    const db = await createTestDb();
    await pushNotification(db, notif);
    await pushNotification(db, notif);
    expect(await unreadCount(db, "did:plc:a")).toBe(1);
  });
  it("markAllRead clears unread; page returns newest first", async () => {
    const db = await createTestDb();
    await pushNotification(db, notif);
    await pushNotification(db, { ...notif, kind: "comment" as const, subjectUri: POST + "#r1", snippet: "nice" });
    const page = await notificationsPage(db, "did:plc:a", { limit: 10 });
    expect(page.items).toHaveLength(2);
    await markAllRead(db, "did:plc:a");
    expect(await unreadCount(db, "did:plc:a")).toBe(0);
  });
  it("markRead clears only the given ids for the given recipient", async () => {
    const db = await createTestDb();
    await pushNotification(db, notif);
    await pushNotification(db, { ...notif, kind: "comment" as const, subjectUri: POST + "#r1", snippet: "nice" });
    await pushNotification(db, { ...notif, recipientDid: "did:plc:other", kind: "follow" as const, subjectUri: "did:plc:v", linkUri: "did:plc:v" });
    const [firstId] = (await notificationsPage(db, "did:plc:a", { limit: 10 })).items
      .map((r) => r.id)
      .sort((a, b) => a - b);
    await markRead(db, "did:plc:a", [firstId]);
    expect(await unreadCount(db, "did:plc:a")).toBe(1);
    expect(await unreadCount(db, "did:plc:other")).toBe(1);
  });
});
