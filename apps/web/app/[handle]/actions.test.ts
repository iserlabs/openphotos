import { describe, it, expect } from "vitest";
import { createTestDb, photographers, type Db } from "@luminance/db";
import { followActionCore, unfollowActionCore } from "./actions";

const VIEWER = "did:plc:viewer";
const PHOTOGRAPHER = "did:plc:photographer";

async function createMockDb(): Promise<Db> {
  const db = await createTestDb();
  await db.insert(photographers).values({ did: PHOTOGRAPHER, handle: "photog.test" });
  return db;
}

describe("followActionCore", () => {
  it("returns signed-in error when session.did is missing", async () => {
    const db = await createMockDb();
    const session = { did: "", handle: "viewer" };
    const formData = new FormData();
    formData.set("photographerDid", PHOTOGRAPHER);
    formData.set("photographerHandle", "photog.test");

    const result = await followActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "sign in to follow this photographer" });
  });

  it("returns missing photographer error when photographerDid is not provided", async () => {
    const db = await createMockDb();
    const session = { did: VIEWER, handle: "viewer" };
    const formData = new FormData();
    formData.set("photographerHandle", "photog.test");

    const result = await followActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "missing photographer" });
  });

  it("returns missing photographer error when photographerHandle is not provided", async () => {
    const db = await createMockDb();
    const session = { did: VIEWER, handle: "viewer" };
    const formData = new FormData();
    formData.set("photographerDid", PHOTOGRAPHER);

    const result = await followActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "missing photographer" });
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
    formData.set("photographerDid", PHOTOGRAPHER);
    formData.set("photographerHandle", "photog.test");

    const result = await followActionCore(failingDb, session, formData);

    expect(result).toEqual({ ok: false, error: "sign in to follow this photographer" });
  });
});

describe("unfollowActionCore", () => {
  it("returns signed-in error when session.did is missing", async () => {
    const db = await createMockDb();
    const session = { did: "", handle: "viewer" };
    const formData = new FormData();
    formData.set("photographerDid", PHOTOGRAPHER);

    const result = await unfollowActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "sign in to unfollow this photographer" });
  });

  it("returns missing photographer error when photographerDid is not provided", async () => {
    const db = await createMockDb();
    const session = { did: VIEWER, handle: "viewer" };
    const formData = new FormData();

    const result = await unfollowActionCore(db, session, formData);

    expect(result).toEqual({ ok: false, error: "missing photographer" });
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
    formData.set("photographerDid", PHOTOGRAPHER);

    const result = await unfollowActionCore(failingDb, session, formData);

    expect(result).toEqual({ ok: false, error: "sign in to unfollow this photographer" });
  });
});
