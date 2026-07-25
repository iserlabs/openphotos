import WebSocket from "ws";
import { eq, sql } from "drizzle-orm";
import { ingestCursors, type Db } from "@luminance/db";
import type { JetstreamEvent } from "./indexer.js";

/** A handler-failed event is replayed (reconnect-from-cursor) at most this
 * many times before being loudly skipped — bounds a poison event's damage. */
const MAX_EVENT_RETRIES = 3;
const PING_INTERVAL_MS = 30_000;
/** Healthy = a pong within 3 ping intervals. */
const PONG_STALE_MS = 3 * PING_INTERVAL_MS;

interface Opts {
  db: Db; url: string; connectionId: string; collections: string[];
  getDids: () => Promise<string[]>;
  onEvent: (e: JetstreamEvent) => Promise<void>;
  onStaleCursor: () => Promise<void>;
  replayWindowUs?: bigint; // default 48h
  didPollIntervalMs?: number; // default 30s registry poll (injectable for tests)
}

export class JetstreamConsumer {
  private ws?: WebSocket; private stopped = false; private backoffMs = 1000;
  private didPoll?: ReturnType<typeof setInterval>; private lastDids = "";
  private reconnectTimer?: ReturnType<typeof setTimeout>; private connecting = false;
  private pingTimer?: ReturnType<typeof setInterval>; private lastPongAt = 0;
  private suspended = false; private failedTimeUs: number | null = null; private failedCount = 0;
  constructor(private o: Opts) {}

  async start() {
    const cursor = await this.readCursor();
    const windowUs = this.o.replayWindowUs ?? 48n * 3600n * 1_000_000n;
    if (cursor !== null && BigInt(Date.now()) * 1000n - cursor > windowUs) {
      await this.o.onStaleCursor(); // reconciliation backfill (spec §9)
    }
    await this.connect(cursor); // no-op when the registry is empty (see connect())
    this.didPoll = setInterval(() => void this.pollDids(), this.o.didPollIntervalMs ?? 30_000); // spec §9: ~30s registry poll
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
    }, PING_INTERVAL_MS);
  }

  /**
   * True when the socket is open and pongs are coming back. Distinguishes a
   * genuinely stalled/dead connection from a merely QUIET one (a single-DID
   * filter with no activity produces zero events, so cursor lag grows at
   * wall-clock rate while nothing is wrong) — the cursor-lag alert uses this
   * to avoid false positives.
   */
  connectionHealthy(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    return Date.now() - this.lastPongAt < PONG_STALE_MS;
  }

  private async readCursor(): Promise<bigint | null> {
    const [row] = await this.o.db.select().from(ingestCursors).where(eq(ingestCursors.connectionId, this.o.connectionId));
    return row?.timeUs ?? null;
  }

  private hasLiveSocket(): boolean {
    return !!this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING);
  }

  private connect(cursor: bigint | null): Promise<void> {
    // Resolves once the socket is open (or has failed to open) so callers
    // (start()/reconnect()) observe a live connection before proceeding —
    // not just a scheduled one.
    return new Promise((resolve, reject) => {
      void (async () => {
        // Never race a second connection attempt against an in-flight or live one.
        if (this.stopped || this.connecting || this.hasLiveSocket()) return resolve();
        this.connecting = true;
        try {
          const dids = await this.o.getDids();
          if (dids.length === 0) {
            // Empty registry: opening a socket with no wantedDids would subscribe
            // to the entire firehose. Skip it — the did-poll reconnects once at
            // least one DID is registered (spec §3 opt-in).
            this.connecting = false;
            return resolve();
          }
          this.lastDids = JSON.stringify(dids);
          const u = new URL(this.o.url);
          u.pathname = "/subscribe";
          for (const c of this.o.collections) u.searchParams.append("wantedCollections", c);
          for (const d of dids) u.searchParams.append("wantedDids", d);
          if (cursor !== null) u.searchParams.set("cursor", String(cursor > 5_000_000n ? cursor - 5_000_000n : 0n)); // 5s replay overlap; idempotent upserts make it harmless (spec §9)
          const ws = new WebSocket(u.toString(), { handshakeTimeout: 15_000 }); // surface a black-holed TCP connect as an error instead of hanging forever
          this.ws = ws;
          ws.once("open", () => {
            this.backoffMs = 1000; this.connecting = false;
            this.lastPongAt = Date.now(); // fresh connection counts healthy until pongs prove otherwise
            this.suspended = false; // replay-from-cursor resumes normal processing
            resolve();
          });
          ws.once("error", () => { this.connecting = false; resolve(); }); // don't hang start()/reconnect() on a failed connection attempt
          ws.on("message", (data) => void this.handleMessage(data.toString()));
          ws.on("pong", () => { this.lastPongAt = Date.now(); });
          ws.on("close", () => void this.reconnect());
          ws.on("error", () => ws.close());
        } catch (err) {
          this.connecting = false;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  }

  private queue: Promise<void> = Promise.resolve();
  private handleMessage(raw: string) {
    this.queue = this.queue.then(async () => {
      // Suspended after a handler failure: later already-queued events must
      // NOT advance the cursor past the failed one (that would skip it
      // permanently — the I6 cursor-gap). They replay after reconnect.
      if (this.suspended) return;
      let evt: JetstreamEvent & { time_us: number };
      try { evt = JSON.parse(raw); } catch { return; }
      try {
        await this.o.onEvent(evt);
      } catch (err) {
        if (this.failedTimeUs === evt.time_us) this.failedCount++;
        else { this.failedTimeUs = evt.time_us; this.failedCount = 1; }
        if (this.failedCount >= MAX_EVENT_RETRIES) {
          // Poison event: after N replays it still fails. Advance the cursor
          // past it LOUDLY — an alerted explicit skip beats the silent one.
          console.error(`jetstream: event at ${evt.time_us} failed ${this.failedCount}x — skipping past it`, err);
          this.failedTimeUs = null; this.failedCount = 0;
          await this.saveCursor(evt.time_us);
          return;
        }
        console.error("jetstream: handler error — reconnecting from cursor to replay the event", err);
        this.suspended = true;
        this.ws?.close(); // close triggers reconnect(), which reads the un-advanced cursor
        return;
      }
      await this.saveCursor(evt.time_us);
    }).catch((err) => console.error("jetstream: pipeline error", err));
  }

  private async saveCursor(timeUs: number) {
    await this.o.db.insert(ingestCursors)
      .values({ connectionId: this.o.connectionId, timeUs: BigInt(timeUs) })
      .onConflictDoUpdate({
        target: ingestCursors.connectionId,
        // greatest(): replayed/stale events queued from a pre-reconnect socket
        // must never move the cursor backwards.
        set: { timeUs: sql`greatest(${ingestCursors.timeUs}, ${BigInt(timeUs)})`, updatedAt: new Date() },
      });
  }

  private async pollDids() {
    if (this.stopped) return;
    const dids = await this.o.getDids();
    if (dids.length === 0) {
      // Registry drained mid-connection: an options_update with EMPTY
      // wantedDids would subscribe the entire firehose. Close the socket
      // instead; this same poll reopens one when a DID registers again.
      if (this.hasLiveSocket()) {
        this.lastDids = "";
        this.ws!.close();
      }
      return;
    }
    if (!this.hasLiveSocket()) {
      // No socket yet — either the registry was empty at startup or a prior
      // connection dropped. Open one as soon as there's at least one DID to
      // filter on.
      await this.connect(await this.readCursor());
      return;
    }
    const j = JSON.stringify(dids);
    if (j === this.lastDids) return;
    this.lastDids = j;
    this.ws!.send(JSON.stringify({ type: "options_update", payload: { wantedCollections: this.o.collections, wantedDids: dids } }));
  }
  refreshDids() { this.lastDids = ""; void this.pollDids(); }

  private async reconnect() {
    if (this.stopped) return;
    await new Promise<void>((r) => { this.reconnectTimer = setTimeout(r, this.backoffMs + Math.random() * 500); });
    if (this.stopped) return; // stop() may have raced the backoff sleep
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    try {
      await this.connect(await this.readCursor());
    } catch (err) {
      console.error("jetstream: reconnect attempt failed, retrying", err); // transient failure (e.g. getDids() DB blip); never crash, just back off again
      void this.reconnect();
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.didPoll);
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    await this.queue;
  }
}
