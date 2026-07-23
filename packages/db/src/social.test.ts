import { describe, it, expect } from "vitest";
import { createTestDb } from "./test-db.js";
import { engagement, interactions } from "./schema.js";
import { engagementFor, recordInteraction, softDeleteInteraction, findInteraction, interactionWritesInWindow, pushNotification, unreadCount, notificationsPage, markAllRead } from "./social.js";

const POST = "at://did:plc:a/app.bsky.feed.post/p1";
const like = (n: number) => ({ recordUri: `at://did:plc:v/app.bsky.feed.like/l${n}`, actorDid: "did:plc:v", kind: "like" as const, subjectUri: POST });

describe("count formula (spec §3 races)", () => {
  it("adds local likes newer than fetchedAt", async () => {
    const db = await createTestDb();
    await db.insert(engagement).values({ postUri: POST, likeCount: 5, fetchedAt: new Date(Date.now() - 60_000) });
    await recordInteraction(db, like(1)); // created now > fetchedAt
    expect((await engagementFor(db, [POST])).get(POST)).toEqual({ likeCount: 6, replyCount: 0 });
  });
  it("does NOT double-count a like the sweep already absorbed", async () => {
    const db = await createTestDb();
    await recordInteraction(db, like(1));
    await db.insert(engagement).values({ postUri: POST, likeCount: 6, fetchedAt: new Date(Date.now() + 1000) }); // sweep after the like
    expect((await engagementFor(db, [POST])).get(POST)!.likeCount).toBe(6);
  });
  it("subtracts an unlike of an absorbed like", async () => {
    const db = await createTestDb();
    await recordInteraction(db, like(1));
    await db.insert(engagement).values({ postUri: POST, likeCount: 6, fetchedAt: new Date(Date.now() + 1000) });
    await softDeleteInteraction(db, like(1).recordUri); // deletedAt now > fetchedAt
    expect((await engagementFor(db, [POST])).get(POST)!.likeCount).toBe(5);
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
});
