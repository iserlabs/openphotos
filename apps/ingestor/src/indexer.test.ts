import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, photos, photographers, tombstones, photoOverrides, series, seriesPhotos } from "@openphotos/db";
import { OPENCONTENT_PHOTOGRAPH, OPENCONTENT_COLLECTION } from "@openphotos/lexicons";
import { Indexer } from "./indexer.js";

const DID = "did:plc:kevin";
// social.luminance.portfolio.{photo,series} were retired 2026-07-28 (zero
// records ever existed in the wild); these fixtures now exercise their
// structural successor, social.opencontent.{photograph,collection}.
const photoEvt = (rkey: string, op: "create" | "delete" = "create") => ({
  did: DID, time_us: 1, kind: "commit" as const,
  commit: { operation: op, collection: OPENCONTENT_PHOTOGRAPH, rkey, cid: "bafyrec",
    record: op === "create" ? { image: { $type: "blob", ref: { $link: `bafk-${rkey}` }, mimeType: "image/jpeg", size: 1 }, aspectRatio: { width: 100, height: 100 }, createdAt: "2026-07-01T00:00:00Z" } : undefined },
});
// generic opencontent photograph create/update event with a custom record body (for asserting upsert field coverage)
const photoRecordEvt = (rkey: string, record: Record<string, unknown>, op: "create" | "update" = "create") => ({
  did: DID, time_us: 1, kind: "commit" as const,
  commit: { operation: op, collection: OPENCONTENT_PHOTOGRAPH, rkey, cid: "bafyrec", record },
});
const seriesEvt = (rkey: string, over: Record<string, unknown>, op: "create" | "update" = "create") => ({
  did: DID, time_us: 1, kind: "commit" as const,
  commit: { operation: op, collection: OPENCONTENT_COLLECTION, rkey, cid: "bafyrec",
    record: { title: "S", items: [], createdAt: "2026-07-01T00:00:00Z", ...over } },
});
const galleryEvt = (rkey: string, over: Record<string, unknown> = {}, op: "create" | "update" = "create") => ({
  did: DID, time_us: 1, kind: "commit" as const,
  commit: { operation: op, collection: "social.grain.gallery", rkey, cid: "bafyrec",
    record: { title: "Gallery", createdAt: "2026-07-01T00:00:00Z", ...over } },
});
const galleryItemEvt = (rkey: string, over: { gallery: string; item: string; position?: number }, op: "create" | "delete" = "create") => ({
  did: DID, time_us: 1, kind: "commit" as const,
  commit: { operation: op, collection: "social.grain.gallery.item", rkey, cid: "bafyrec",
    record: op === "create" ? { gallery: over.gallery, item: over.item, position: over.position ?? 0, createdAt: "2026-07-01T00:00:00Z" } : undefined },
});
const bskyProfileEvt = (record: Record<string, unknown>, did: string = DID) => ({
  did, time_us: 1, kind: "commit" as const,
  commit: { operation: "create" as const, collection: "app.bsky.actor.profile", rkey: "self", cid: "bafyrec", record },
});

describe("Indexer", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let ix: Indexer;
  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "klee.photos" });
    ix = new Indexer(db);
  });
  it("indexes an opencontent photograph create", async () => {
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
  it("account-active event does not resurrect a pending_review photographer", async () => {
    await db.update(photographers).set({ status: "pending_review" }).where(eq(photographers.did, DID));
    await ix.handleEvent({ did: DID, time_us: 2, kind: "account", account: { active: true } });
    const [row] = await db.select().from(photographers);
    expect(row.status).toBe("pending_review");
  });
  it("account-active event does not resurrect a deregistered photographer", async () => {
    await db.update(photographers).set({ status: "deregistered" }).where(eq(photographers.did, DID));
    await ix.handleEvent({ did: DID, time_us: 2, kind: "account", account: { active: true } });
    const [row] = await db.select().from(photographers);
    expect(row.status).toBe("deregistered");
  });
  it("account-active event reactivates a PDS-deactivated photographer", async () => {
    await db.update(photographers).set({ status: "deactivated" }).where(eq(photographers.did, DID));
    await ix.handleEvent({ did: DID, time_us: 2, kind: "account", account: { active: true } });
    const [row] = await db.select().from(photographers);
    expect(row.status).toBe("active");
  });
  it("identity event refreshes handle", async () => {
    await ix.handleEvent({ did: DID, time_us: 3, kind: "identity", identity: { handle: "new.example.com" } });
    const [row] = await db.select().from(photographers);
    expect(row.handle).toBe("new.example.com");
  });

  it("deleting a photo also removes seriesPhotos rows referencing it as photoUri", async () => {
    const photoUri = `at://${DID}/${OPENCONTENT_PHOTOGRAPH}/p1`;
    await ix.handleEvent(photoEvt("p1"));
    await ix.handleEvent(seriesEvt("s1", { items: [{ uri: photoUri, cid: "bafyrec" }] }));
    expect(await db.select().from(seriesPhotos)).toHaveLength(1);

    await ix.handleEvent(photoEvt("p1", "delete"));
    expect(await db.select().from(seriesPhotos)).toHaveLength(0);
  });

  it("grain gallery.item events create independent membership rows keyed by their own atUri", async () => {
    const galleryUri = `at://${DID}/social.grain.gallery/g1`;
    await ix.handleEvent(galleryItemEvt("i1", { gallery: galleryUri, item: `at://${DID}/social.grain.photo/ph1`, position: 0 }));
    await ix.handleEvent(galleryItemEvt("i2", { gallery: galleryUri, item: `at://${DID}/social.grain.photo/ph2`, position: 1 }));
    expect(await db.select().from(seriesPhotos)).toHaveLength(2);

    await ix.handleEvent(galleryItemEvt("i1", { gallery: galleryUri, item: `at://${DID}/social.grain.photo/ph1` }, "delete"));
    const rows = await db.select().from(seriesPhotos);
    expect(rows).toHaveLength(1);
    expect(rows[0].photoUri).toBe(`at://${DID}/social.grain.photo/ph2`);
  });

  it("an update changes width and license on an existing photo row", async () => {
    await ix.handleEvent(photoEvt("p1"));
    await ix.handleEvent(photoRecordEvt("p1", {
      image: { $type: "blob", ref: { $link: "bafk-p1" }, mimeType: "image/jpeg", size: 1 },
      aspectRatio: { width: 4000, height: 3000 }, license: "cc-by",
      createdAt: "2026-07-01T00:00:00Z",
    }, "update"));
    const [row] = await db.select().from(photos);
    expect(row.width).toBe(4000);
    expect(row.height).toBe(3000);
    expect(row.license).toBe("cc-by");
  });

  it("an opencontent collection update with items:[] clears memberships; a grain gallery update leaves gallery.item memberships intact", async () => {
    const photoUri = `at://${DID}/${OPENCONTENT_PHOTOGRAPH}/p1`;
    await ix.handleEvent(photoEvt("p1"));
    await ix.handleEvent(seriesEvt("s1", { items: [{ uri: photoUri, cid: "bafyrec" }] }));
    expect(await db.select().from(seriesPhotos)).toHaveLength(1);
    await ix.handleEvent(seriesEvt("s1", { items: [] }, "update"));
    expect(await db.select().from(seriesPhotos)).toHaveLength(0);

    const galleryUri = `at://${DID}/social.grain.gallery/g1`;
    await ix.handleEvent(galleryEvt("g1"));
    await ix.handleEvent(galleryItemEvt("i1", { gallery: galleryUri, item: `at://${DID}/social.grain.photo/ph1` }));
    expect(await db.select().from(seriesPhotos)).toHaveLength(1);

    await ix.handleEvent(galleryEvt("g1", { title: "Updated title" }, "update"));
    expect(await db.select().from(seriesPhotos)).toHaveLength(1); // gallery.item membership is not authoritative-managed
  });

  it("bsky profile fallback fills a blank bio but does not overwrite an existing bio", async () => {
    await db.update(photographers).set({ bio: "Existing bio" }).where(eq(photographers.did, DID));
    await ix.handleEvent(bskyProfileEvt({ description: "New bio from bsky" }));
    const [existing] = await db.select().from(photographers).where(eq(photographers.did, DID));
    expect(existing.bio).toBe("Existing bio");

    const DID2 = "did:plc:blank";
    await db.insert(photographers).values({ did: DID2, handle: "blank.photos" });
    await ix.handleEvent(bskyProfileEvt({ description: "Filled bio" }, DID2));
    const [blank] = await db.select().from(photographers).where(eq(photographers.did, DID2));
    expect(blank.bio).toBe("Filled bio");
  });
});
