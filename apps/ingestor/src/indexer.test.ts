import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, photos, photographers, tombstones, photoOverrides } from "@luminance/db";
import { Indexer } from "./indexer.js";

const DID = "did:plc:kevin";
const photoEvt = (rkey: string, op: "create" | "delete" = "create") => ({
  did: DID, time_us: 1, kind: "commit" as const,
  commit: { operation: op, collection: "social.luminance.portfolio.photo", rkey, cid: "bafyrec",
    record: op === "create" ? { image: { $type: "blob", ref: { $link: `bafk-${rkey}` }, mimeType: "image/jpeg", size: 1 }, createdAt: "2026-07-01T00:00:00Z" } : undefined },
});

describe("Indexer", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let ix: Indexer;
  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "klee.photos" });
    ix = new Indexer(db);
  });
  it("indexes a luminance photo create", async () => {
    await ix.handleEvent(photoEvt("p1"));
    expect((await db.select().from(photos))).toHaveLength(1);
  });
  it("upsert is idempotent (replay-safe)", async () => {
    await ix.handleEvent(photoEvt("p1"));
    await ix.handleEvent(photoEvt("p1"));
    expect((await db.select().from(photos))).toHaveLength(1);
  });
  it("delete removes all rows for the AT-URI and tombstones during active backfill", async () => {
    await ix.handleEvent(photoEvt("p1"));
    await db.update(photographers).set({ backfillStatus: "running" });
    await ix.handleEvent(photoEvt("p1", "delete"));
    expect(await db.select().from(photos)).toHaveLength(0);
    expect(await db.select().from(tombstones)).toHaveLength(1);
  });
  it("ignores events from unregistered DIDs", async () => {
    await ix.handleEvent({ ...photoEvt("p1"), did: "did:plc:stranger" });
    expect(await db.select().from(photos)).toHaveLength(0);
  });
  it("skips invalid records without throwing", async () => {
    const evt = photoEvt("bad");
    (evt.commit as any).record = { nope: true };
    await expect(ix.handleEvent(evt)).resolves.toBeUndefined();
    expect(await db.select().from(photos)).toHaveLength(0);
    expect(ix.stats.skipped).toBe(1);
  });
  it("account deactivation hides the photographer", async () => {
    await ix.handleEvent({ did: DID, time_us: 2, kind: "account", account: { active: false, status: "deactivated" } });
    const [row] = await db.select().from(photographers);
    expect(row.status).toBe("deactivated");
  });
  it("identity event refreshes handle", async () => {
    await ix.handleEvent({ did: DID, time_us: 3, kind: "identity", identity: { handle: "new.example.com" } });
    const [row] = await db.select().from(photographers);
    expect(row.handle).toBe("new.example.com");
  });
});
