import { describe, it, expect } from "vitest";
import { createTestDb, photographers } from "@openphotos/db";
import { eq } from "drizzle-orm";
import { requestRefresh } from "./refresh";

const DID = "did:plc:kevin";

describe("requestRefresh", () => {
  it("rejects signed-out and non-photographer callers", async () => {
    const db = await createTestDb();
    expect((await requestRefresh(db, null)).ok).toBe(false);
    expect((await requestRefresh(db, "did:plc:stranger")).ok).toBe(false);
  });

  it("rejects non-active photographers", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "k.test", status: "deregistered" });
    expect((await requestRefresh(db, DID)).ok).toBe(false);
  });

  it("re-arms a complete photographer to pending", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "k.test", backfillStatus: "complete" });
    const res = await requestRefresh(db, DID);
    expect(res).toEqual({ ok: true });
    const [row] = await db.select().from(photographers).where(eq(photographers.did, DID));
    expect(row.backfillStatus).toBe("pending");
  });

  it("is idempotent while a walk is pending or running", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "k.test", backfillStatus: "running" });
    const res = await requestRefresh(db, DID);
    expect(res).toEqual({ ok: true, alreadyRunning: true });
    const [row] = await db.select().from(photographers).where(eq(photographers.did, DID));
    expect(row.backfillStatus).toBe("running"); // untouched
  });
});
