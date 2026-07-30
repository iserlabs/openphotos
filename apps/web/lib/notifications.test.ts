import { describe, it, expect } from "vitest";
import { createTestDb, photographers, pushNotification, unreadCount, notificationsPage, type Db } from "@openphotos/db";
import { markReadFor, markAllReadFor } from "./notifications";

const A = "did:plc:a";
const B = "did:plc:b";
// Signed in (has a session), but never completed photographer registration.
const VIEWER = "did:plc:viewer";

async function register(db: Db, did: string, handle: string) {
  await db.insert(photographers).values({ did, handle });
}

async function idsFor(db: Db, recipientDid: string) {
  const page = await notificationsPage(db, recipientDid, { limit: 10 });
  return page.items.map((n) => n.id);
}

describe("markReadFor", () => {
  it("marks the session's own rows read", async () => {
    const db = await createTestDb();
    await register(db, A, "a.test");
    await pushNotification(db, { recipientDid: A, actorDid: "did:plc:v", actorHandle: "v.test", kind: "follow", subjectUri: A, linkUri: "/a.test" });
    await markReadFor(db, A, await idsFor(db, A));
    expect(await unreadCount(db, A)).toBe(0);
  });

  it("cannot mark another recipient's rows, even given their ids directly", async () => {
    const db = await createTestDb();
    await register(db, A, "a.test");
    await register(db, B, "b.test");
    await pushNotification(db, { recipientDid: B, actorDid: "did:plc:v", actorHandle: "v.test", kind: "follow", subjectUri: B, linkUri: "/b.test" });
    const bIds = await idsFor(db, B);

    // A's session, but B's row ids — must not touch B's rows.
    await markReadFor(db, A, bIds);
    expect(await unreadCount(db, B)).toBe(1);
  });

  it("no-ops for a signed-out session (sessionDid undefined)", async () => {
    const db = await createTestDb();
    await register(db, A, "a.test");
    await pushNotification(db, { recipientDid: A, actorDid: "did:plc:v", actorHandle: "v.test", kind: "follow", subjectUri: A, linkUri: "/a.test" });
    await markReadFor(db, undefined, await idsFor(db, A));
    expect(await unreadCount(db, A)).toBe(1);
  });

  it("no-ops for a viewer session that never registered as a photographer", async () => {
    const db = await createTestDb();
    await register(db, A, "a.test");
    await pushNotification(db, { recipientDid: A, actorDid: "did:plc:v", actorHandle: "v.test", kind: "follow", subjectUri: A, linkUri: "/a.test" });
    await markReadFor(db, VIEWER, await idsFor(db, A));
    expect(await unreadCount(db, A)).toBe(1);
  });
});

describe("markAllReadFor", () => {
  it("clears all of the session's own unread rows", async () => {
    const db = await createTestDb();
    await register(db, A, "a.test");
    await pushNotification(db, { recipientDid: A, actorDid: "did:plc:v", actorHandle: "v.test", kind: "follow", subjectUri: A, linkUri: "/a.test" });
    await pushNotification(db, { recipientDid: A, actorDid: "did:plc:w", actorHandle: "w.test", kind: "like", subjectUri: "at://x/y/z", linkUri: "at://x/y/z" });
    await markAllReadFor(db, A);
    expect(await unreadCount(db, A)).toBe(0);
  });

  it("cannot clear another recipient's rows", async () => {
    const db = await createTestDb();
    await register(db, A, "a.test");
    await register(db, B, "b.test");
    await pushNotification(db, { recipientDid: B, actorDid: "did:plc:v", actorHandle: "v.test", kind: "follow", subjectUri: B, linkUri: "/b.test" });
    await markAllReadFor(db, A);
    expect(await unreadCount(db, B)).toBe(1);
  });

  it("no-ops for signed-out and non-photographer sessions", async () => {
    const db = await createTestDb();
    await register(db, A, "a.test");
    await pushNotification(db, { recipientDid: A, actorDid: "did:plc:v", actorHandle: "v.test", kind: "follow", subjectUri: A, linkUri: "/a.test" });
    await markAllReadFor(db, undefined);
    await markAllReadFor(db, VIEWER);
    expect(await unreadCount(db, A)).toBe(1);
  });
});
