import { describe, it, expect, vi } from "vitest";
import { createTestDb, photographers, type Db } from "@openphotos/db";
import type { Agent } from "@atproto/api";
import { likeActionCore, unlikeActionCore, commentActionCore, deleteCommentActionCore } from "./actions";

const POST_URI = "at://did:plc:photographer/app.bsky.feed.post/p1";
const VIEWER = "did:plc:viewer";
const PHOTOGRAPHER = "did:plc:photographer";

/**
 * Mock getPhotoRecord to avoid coupling to queries.ts or the database.
 * Returns a test photo record matching the structure expected by actions.
 */
function mockPhotoRecord(atUri: string = POST_URI) {
  return {
    photographer: { did: PHOTOGRAPHER },
    items: [
      {
        source: "bsky",
        atUri: POST_URI,
        recordCid: "bafypost1",
      },
    ],
  };
}

/**
 * Mock getDb to return a test database.
 */
async function createMockDb(): Promise<Db> {
  const db = await createTestDb();
  // Pre-register the photographer for notification tests
  await db.insert(photographers).values({ did: PHOTOGRAPHER, handle: "photog.test" });
  return db;
}

describe("likeActionCore", () => {
  it("returns signed-in error when session.did is missing", async () => {
    const db = await createMockDb();
    const session = { did: "", handle: "viewer" };
    const formData = new FormData();
    formData.set("atUri", POST_URI);

    const result = await likeActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "sign in to like this photo" });
  });

  it("returns missing photo error when atUri is not provided", async () => {
    const db = await createMockDb();
    const session = { did: VIEWER, handle: "viewer" };
    const formData = new FormData();

    const result = await likeActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "missing photo" });
  });

  it("returns signed-in error before trying to access db (session check first)", async () => {
    const failingDb = new Proxy(
      {},
      {
        get() {
          throw new Error("db should not be accessed");
        },
      },
    ) as Db;
    const session = { did: "" };
    const formData = new FormData();
    formData.set("atUri", POST_URI);

    const result = await likeActionCore(failingDb, session, formData);

    expect(result).toEqual({ ok: false, error: "sign in to like this photo" });
  });
});

describe("unlikeActionCore", () => {
  it("returns signed-in error when session.did is missing", async () => {
    const db = await createMockDb();
    const session = { did: "", handle: "viewer" };
    const formData = new FormData();
    formData.set("atUri", POST_URI);

    const result = await unlikeActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "sign in to like this photo" });
  });

  it("returns missing photo error when atUri is not provided", async () => {
    const db = await createMockDb();
    const session = { did: VIEWER, handle: "viewer" };
    const formData = new FormData();

    const result = await unlikeActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "missing photo" });
  });

  it("returns signed-in error before trying to access db (session check first)", async () => {
    const failingDb = new Proxy(
      {},
      {
        get() {
          throw new Error("db should not be accessed");
        },
      },
    ) as Db;
    const session = { did: "" };
    const formData = new FormData();
    formData.set("atUri", POST_URI);

    const result = await unlikeActionCore(failingDb, session, formData);

    expect(result).toEqual({ ok: false, error: "sign in to like this photo" });
  });
});

describe("commentActionCore", () => {
  it("returns signed-in error when session.did is missing", async () => {
    const db = await createMockDb();
    const session = { did: "", handle: "viewer" };
    const formData = new FormData();
    formData.set("atUri", POST_URI);
    formData.set("text", "nice shot");

    const result = await commentActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "sign in to comment on this photo" });
  });

  it("returns missing photo error when atUri is not provided", async () => {
    const db = await createMockDb();
    const session = { did: VIEWER, handle: "viewer" };
    const formData = new FormData();
    formData.set("text", "nice shot");

    const result = await commentActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "missing photo" });
  });

  it("returns signed-in error before trying to access db (session check first)", async () => {
    const failingDb = new Proxy(
      {},
      {
        get() {
          throw new Error("db should not be accessed");
        },
      },
    ) as Db;
    const session = { did: "" };
    const formData = new FormData();
    formData.set("atUri", POST_URI);
    formData.set("text", "nice shot");

    const result = await commentActionCore(failingDb, session, formData);

    expect(result).toEqual({ ok: false, error: "sign in to comment on this photo" });
  });
});

describe("deleteCommentActionCore", () => {
  it("returns signed-in error when session.did is missing", async () => {
    const db = await createMockDb();
    const session = { did: "", handle: "viewer" };
    const formData = new FormData();
    formData.set("recordUri", "at://did:plc:viewer/app.bsky.feed.post/c1");

    const result = await deleteCommentActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "sign in to delete this comment" });
  });

  it("returns missing comment error when recordUri is not provided", async () => {
    const db = await createMockDb();
    const session = { did: VIEWER, handle: "viewer" };
    const formData = new FormData();

    const result = await deleteCommentActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "missing comment" });
  });

  it("returns signed-in error before trying to access db (session check first)", async () => {
    const failingDb = new Proxy(
      {},
      {
        get() {
          throw new Error("db should not be accessed");
        },
      },
    ) as Db;
    const session = { did: "" };
    const formData = new FormData();
    formData.set("recordUri", "at://did:plc:viewer/app.bsky.feed.post/c1");

    const result = await deleteCommentActionCore(failingDb, session, formData);

    expect(result).toEqual({ ok: false, error: "sign in to delete this comment" });
  });
});
