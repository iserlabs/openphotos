import { Sentry, sentryEnabled } from "./sentry.js"; // must be imported first: initializes Sentry before other modules load
import { ne, eq } from "drizzle-orm";
import { createDb, photographers, ingestCursors, type Db } from "@luminance/db";
import {
  LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE,
  OPENCONTENT_PHOTOGRAPH, OPENCONTENT_COLLECTION,
} from "@luminance/lexicons";
import { GRAIN_COLLECTIONS, AppView } from "@luminance/atproto";
import { config } from "./config.js";
import { Indexer } from "./indexer.js";
import { JetstreamConsumer } from "./jetstream.js";
import { startHealthServer } from "./health.js";
import { startBackfillLoop } from "./backfill.js";
import { createFreshnessProbe } from "./freshness-probe.js";
import { cursorLagSeconds } from "./cursor-lag.js";
import { startEngagementSweep } from "./engagement-sweep.js";

const CURSOR_LAG_CONNECTION_ID = "main"; // matches JetstreamConsumer's connectionId below
const CURSOR_LAG_CHECK_INTERVAL_MS = 60_000;
const CURSOR_LAG_ALERT_THRESHOLD_S = 300;

// social.luminance.portfolio.{photo,series} were retired 2026-07-28 (zero
// records ever existed in the wild) and dropped from this list; LUMINANCE_PROFILE
// (social.luminance.actor.profile) stays watched.
const WANTED_COLLECTIONS = [
  LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE, ...GRAIN_COLLECTIONS,
  OPENCONTENT_PHOTOGRAPH, OPENCONTENT_COLLECTION,
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
 * Always logs an info-level `cursor_lag_seconds=<n>` line.
 *
 * False-positive gating (fast-follow): with a quiet single-DID filter, zero
 * events means the lag grows at wall-clock rate though nothing is wrong. Two
 * signals distinguish real trouble from quiet:
 *  - `connectionHealthy()` (ws ping/pong): a dead/stalled socket alerts.
 *  - `lastRevChangeAt()` (freshness probe, PDS truth): repo activity newer
 *    than the cursor while the socket looks healthy = upstream starvation
 *    (the documented Jetstream incident) — also alerts.
 * Healthy socket + no observed repo activity = quiet filter; log only.
 */
async function checkCursorLag(
  db: Db,
  signals: { connectionHealthy(): boolean; lastRevChangeAt(): number | null },
): Promise<void> {
  const [row] = await db.select().from(ingestCursors).where(eq(ingestCursors.connectionId, CURSOR_LAG_CONNECTION_ID));
  if (!row) return; // no events consumed yet
  const lagSeconds = cursorLagSeconds(row.timeUs, Date.now());
  console.log(`cursor_lag_seconds=${lagSeconds}`);
  if (lagSeconds <= CURSOR_LAG_ALERT_THRESHOLD_S) return;

  const cursorMs = Number(row.timeUs / 1000n);
  const revChange = signals.lastRevChangeAt();
  const starving = revChange !== null && revChange > cursorMs;
  if (!signals.connectionHealthy() || starving) {
    const cause = starving ? "repo activity newer than cursor (upstream starvation)" : "socket unhealthy";
    const msg = `ingestor: cursor lag ${lagSeconds}s exceeds ${CURSOR_LAG_ALERT_THRESHOLD_S}s — ${cause}`;
    console.error(msg);
    if (sentryEnabled) Sentry.captureMessage(msg, "error");
  } else {
    console.log(`cursor_lag_quiet_filter=1 lag_s=${lagSeconds}`); // quiet filter, not a stall
  }
}

function startCursorLagMonitor(
  db: Db,
  signals: { connectionHealthy(): boolean; lastRevChangeAt(): number | null },
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void checkCursorLag(db, signals).catch((err) => console.error("cursor-lag: check failed", err));
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
  const freshnessProbe = createFreshnessProbe(db); freshnessProbe.start(); // asks each PDS for its repo rev — automatic freshness while Jetstream starves this PDS
  const backfillTimer = startBackfillLoop(db, indexer);
  const cursorLagTimer = startCursorLagMonitor(db, {
    connectionHealthy: () => consumer.connectionHealthy(),
    lastRevChangeAt: () => freshnessProbe.lastRevChangeAt(),
  });
  const engagementSweep = startEngagementSweep(db, new AppView());

  // Graceful shutdown (SIGTERM = Fly deploys/restarts; SIGINT = local ctrl-C):
  // stop timers first so nothing re-arms, then drain the consumer's in-flight
  // event queue via stop() so the cursor lands consistently, then exit. A
  // second signal (or a 10s drain hang) force-exits.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) { console.error("ingestor: forced exit"); process.exit(1); }
    shuttingDown = true;
    console.log(`ingestor: ${signal} received, shutting down`);
    clearInterval(backfillTimer);
    clearInterval(cursorLagTimer);
    freshnessProbe.stop();
    engagementSweep.stop();
    const forceTimer = setTimeout(() => { console.error("ingestor: drain timed out, forcing exit"); process.exit(1); }, 10_000);
    void consumer.stop().then(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

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
