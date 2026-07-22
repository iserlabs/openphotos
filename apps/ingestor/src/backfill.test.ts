import { describe, it, expect } from "vitest";
import { createTestDb, photos, photographers, tombstones } from "@luminance/db";
import { LUMINANCE_PHOTO, BSKY_POST } from "@luminance/lexicons";
import { Indexer } from "./indexer.js";
import { runBackfill, startBackfillLoop } from "./backfill.js";

const DID = "did:plc:kevin";
const rec = (rkey: string) => ({
  uri: `at://${DID}/social.luminance.portfolio.photo/${rkey}`, cid: "bafyrec",
  value: { $type: "social.luminance.portfolio.photo", image: { $type: "blob", ref: { $link: `bafk-${rkey}` }, mimeType: "image/jpeg", size: 1 }, createdAt: "2026-07-01T00:00:00Z" },
});
const bskyRec = (rkey: string) => ({
  uri: `at://${DID}/app.bsky.feed.post/${rkey}`, cid: "bafybsky",
  value: {
    $type: "app.bsky.feed.post", createdAt: "2026-07-01T00:00:00Z", text: "hi",
    embed: { $type: "app.bsky.embed.images", images: [{ image: { $type: "blob", ref: { $link: `bafk-${rkey}` }, mimeType: "image/jpeg", size: 1 }, alt: "" }] },
  },
});
// fake PDS: only the luminance photo collection has records
const fetchJson = async (url: string) => {
  const u = new URL(url);
  if (u.pathname.endsWith("/xrpc/com.atproto.repo.listRecords") && u.searchParams.get("collection") === "social.luminance.portfolio.photo" && !u.searchParams.get("cursor")) {
    return { records: [rec("p1"), rec("p2")], cursor: undefined };
  }
  return { records: [] };
};
const resolvePds = async () => "https://pds.example.com";

describe("runBackfill", () => {
  it("indexes repo history and marks complete", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "klee.photos" });
    await runBackfill(db, new Indexer(db), DID, { fetchJson, resolvePds });
    expect(await db.select().from(photos)).toHaveLength(2);
    const [ph] = await db.select().from(photographers);
    expect(ph.backfillStatus).toBe("complete");
  });

  it("does not resurrect a record deleted mid-backfill (tombstone) and prunes tombstones after", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "klee.photos", backfillStatus: "running" });
    await db.insert(tombstones).values({ atUri: rec("p1").uri }); // live delete arrived first
    await runBackfill(db, new Indexer(db), DID, { fetchJson, resolvePds });
    const rows = await db.select().from(photos);
    expect(rows.map((r) => r.atUri)).toEqual([rec("p2").uri]); // p1 stayed dead
    expect(await db.select().from(tombstones)).toHaveLength(0); // pruned on completion
  });

  it("marks failed when the PDS is unreachable", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "klee.photos" });
    await runBackfill(db, new Indexer(db), DID, { fetchJson: async () => { throw new Error("down"); }, resolvePds, maxAttempts: 2, retryDelayMs: 1 });
    const [ph] = await db.select().from(photographers);
    expect(ph.backfillStatus).toBe("failed");
  });

  it("skips the bsky collection entirely when includeBsky is false (toggle gate; saves the network call too)", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "klee.photos", includeBsky: false });
    const seenCollections: string[] = [];
    const fetchJsonWithBsky = async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/xrpc/com.atproto.repo.listRecords")) {
        const collection = u.searchParams.get("collection")!;
        seenCollections.push(collection);
        if (!u.searchParams.get("cursor")) {
          // bsky records would be indexed here if the gate leaked; luminance
          // records prove other collections are still walked normally.
          if (collection === BSKY_POST) return { records: [bskyRec("b1")], cursor: undefined };
          if (collection === LUMINANCE_PHOTO) return { records: [rec("p1")], cursor: undefined };
        }
      }
      return { records: [] };
    };
    await runBackfill(db, new Indexer(db), DID, { fetchJson: fetchJsonWithBsky, resolvePds });

    expect(seenCollections).not.toContain(BSKY_POST); // never requested from the PDS
    expect(seenCollections).toContain(LUMINANCE_PHOTO); // other collections still walked

    const rows = await db.select().from(photos);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("luminance"); // no bsky rows made it in
  });

  it("the backfill loop skips a deregistered photographer even when marked pending", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "klee.photos", status: "deregistered", backfillStatus: "pending" });
    const timer = startBackfillLoop(db, new Indexer(db), 20);
    try {
      await new Promise((r) => setTimeout(r, 90)); // several ticks
    } finally {
      clearInterval(timer);
    }
    const [ph] = await db.select().from(photographers);
    // runBackfill would have flipped 'pending' -> 'running' on its first line;
    // still 'pending' proves the loop never picked it up (no PDS call either).
    expect(ph.backfillStatus).toBe("pending");
    expect(await db.select().from(photos)).toHaveLength(0);
  });

  it("multi-DID tombstone isolation: only prunes the backfilled DID's tombstones", async () => {
    const db = await createTestDb();
    const DID_A = "did:plc:alice";
    const DID_B = "did:plc:bob";

    // Seed two photographers
    await db.insert(photographers).values([
      { did: DID_A, handle: "alice.photos", backfillStatus: "running" },
      { did: DID_B, handle: "bob.photos", backfillStatus: "pending" },
    ]);

    // Insert tombstones for both DIDs
    const tombstoneA = `at://${DID_A}/social.luminance.portfolio.photo/tomb-a`;
    const tombstoneB = `at://${DID_B}/social.luminance.portfolio.photo/tomb-b`;
    await db.insert(tombstones).values([
      { atUri: tombstoneA },
      { atUri: tombstoneB },
    ]);

    // Run backfill for DID A only
    const fetchJsonForA = async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/xrpc/com.atproto.repo.listRecords") && u.searchParams.get("repo") === DID_A && !u.searchParams.get("cursor")) {
        return { records: [rec("p1")], cursor: undefined };
      }
      return { records: [] };
    };

    await runBackfill(db, new Indexer(db), DID_A, { fetchJson: fetchJsonForA, resolvePds });

    // Assert: DID A's tombstone is pruned, DID B's tombstone still exists
    const remainingTombstones = await db.select().from(tombstones);
    expect(remainingTombstones.map((t) => t.atUri)).toEqual([tombstoneB]);
  });
});
