import { ne } from "drizzle-orm";
import { createDb, photographers, type Db } from "@luminance/db";
import { LUMINANCE_PHOTO, LUMINANCE_SERIES, LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE } from "@luminance/lexicons";
import { GRAIN_COLLECTIONS } from "@luminance/atproto";
import { config } from "./config.js";
import { Indexer } from "./indexer.js";
import { JetstreamConsumer } from "./jetstream.js";
import { startHealthServer } from "./health.js";
import { startBackfillLoop } from "./backfill.js";

const WANTED_COLLECTIONS = [
  LUMINANCE_PHOTO, LUMINANCE_SERIES, LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE, ...GRAIN_COLLECTIONS,
];

// Live socket + registry poll only care about photographers still opted in;
// 'deregistered' is a terminal state (spec §3).
async function getDids(db: Db): Promise<string[]> {
  const rows = await db.select({ did: photographers.did }).from(photographers).where(ne(photographers.status, "deregistered"));
  return rows.map((r) => r.did);
}

// The stored cursor fell outside Jetstream's replay window: we can no longer
// trust the live stream alone, so force every photographer through a full
// backfill sweep for reconciliation (spec §9).
async function onStaleCursor(db: Db): Promise<void> {
  await db.update(photographers).set({ backfillStatus: "pending" });
}

/**
 * Everything that should run for the life of the process besides one-shot
 * setup: the Jetstream consumer, the health server, and the backfill-runner
 * loop (polls photographers with backfillStatus 'pending' and drives each
 * through a PDS listRecords backfill).
 */
async function startBackgroundJobs(db: Db, indexer: Indexer): Promise<void> {
  const consumer = new JetstreamConsumer({
    db,
    url: config.JETSTREAM_URL,
    connectionId: "main",
    collections: WANTED_COLLECTIONS,
    getDids: () => getDids(db),
    onEvent: (evt) => indexer.handleEvent(evt),
    onStaleCursor: () => onStaleCursor(db),
  });

  startHealthServer(indexer.stats, config.HEALTH_PORT);
  const backfillTimer = startBackfillLoop(db, indexer); // graceful shutdown will clear this
  await consumer.start();
}

async function main(): Promise<void> {
  const db = createDb(config.DATABASE_URL);
  const indexer = new Indexer(db);
  await startBackgroundJobs(db, indexer);
}

main().catch((err) => {
  console.error("ingestor: fatal", err);
  process.exit(1);
});
