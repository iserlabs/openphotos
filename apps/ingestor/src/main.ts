import { Sentry, sentryEnabled } from "./sentry.js"; // must be imported first: initializes Sentry before other modules load
import { ne, eq } from "drizzle-orm";
import { createDb, photographers, ingestCursors, type Db } from "@luminance/db";
import { LUMINANCE_PHOTO, LUMINANCE_SERIES, LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE } from "@luminance/lexicons";
import { GRAIN_COLLECTIONS, AppView } from "@luminance/atproto";
import { config } from "./config.js";
import { Indexer } from "./indexer.js";
import { JetstreamConsumer } from "./jetstream.js";
import { startHealthServer } from "./health.js";
import { startBackfillLoop } from "./backfill.js";
import { cursorLagSeconds } from "./cursor-lag.js";
import { startEngagementSweep } from "./engagement-sweep.js";

const CURSOR_LAG_CONNECTION_ID = "main"; // matches JetstreamConsumer's connectionId below
const CURSOR_LAG_CHECK_INTERVAL_MS = 60_000;
const CURSOR_LAG_ALERT_THRESHOLD_S = 300;

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
  // 'deregistered' is a terminal opt-out — never re-arm its backfill, which
  // would re-index a photographer who left (spec §3).
  await db.update(photographers).set({ backfillStatus: "pending" }).where(ne(photographers.status, "deregistered"));
}

/**
 * Reads the live-consumer cursor row and reports how far behind "now" it is.
 * Always logs an info-level `cursor_lag_seconds=<n>` line; logs an error
 * (and alerts Sentry, if enabled) once the lag crosses the alert threshold —
 * a sign the Jetstream connection has stalled or is falling behind.
 */
async function checkCursorLag(db: Db): Promise<void> {
  const [row] = await db.select().from(ingestCursors).where(eq(ingestCursors.connectionId, CURSOR_LAG_CONNECTION_ID));
  if (!row) return; // no events consumed yet
  const lagSeconds = cursorLagSeconds(row.timeUs, Date.now());
  console.log(`cursor_lag_seconds=${lagSeconds}`);
  if (lagSeconds > CURSOR_LAG_ALERT_THRESHOLD_S) {
    const msg = `ingestor: cursor lag ${lagSeconds}s exceeds ${CURSOR_LAG_ALERT_THRESHOLD_S}s threshold`;
    console.error(msg);
    if (sentryEnabled) Sentry.captureMessage(msg, "error");
  }
}

function startCursorLagMonitor(db: Db): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void checkCursorLag(db).catch((err) => console.error("cursor-lag: check failed", err));
  }, CURSOR_LAG_CHECK_INTERVAL_MS);
}

/**
 * Everything that should run for the life of the process besides one-shot
 * setup: the Jetstream consumer, the health server, the backfill-runner loop
 * (polls photographers with backfillStatus 'pending' and drives each through
 * a PDS listRecords backfill), and the engagement sweep (registered
 * photographers' bsky-source post counts + notification diffing, spec §5).
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
  const cursorLagTimer = startCursorLagMonitor(db); // graceful shutdown will clear this
  const engagementSweep = startEngagementSweep(db, new AppView()); // graceful shutdown will clear this
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
