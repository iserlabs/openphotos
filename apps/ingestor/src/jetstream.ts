import WebSocket from "ws";
import { eq } from "drizzle-orm";
import { ingestCursors, type Db } from "@luminance/db";
import type { JetstreamEvent } from "./indexer.js";

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
  constructor(private o: Opts) {}

  async start() {
    const cursor = await this.readCursor();
    const windowUs = this.o.replayWindowUs ?? 48n * 3600n * 1_000_000n;
    if (cursor !== null && BigInt(Date.now()) * 1000n - cursor > windowUs) {
      await this.o.onStaleCursor(); // reconciliation backfill (spec §9)
    }
    await this.connect(cursor); // no-op when the registry is empty (see connect())
    this.didPoll = setInterval(() => void this.pollDids(), this.o.didPollIntervalMs ?? 30_000); // spec §9: ~30s registry poll
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
          ws.once("open", () => { this.backoffMs = 1000; this.connecting = false; resolve(); });
          ws.once("error", () => { this.connecting = false; resolve(); }); // don't hang start()/reconnect() on a failed connection attempt
          ws.on("message", (data) => void this.handleMessage(data.toString()));
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
      let evt: JetstreamEvent & { time_us: number };
      try { evt = JSON.parse(raw); } catch { return; }
      await this.o.onEvent(evt);
      await this.o.db.insert(ingestCursors)
        .values({ connectionId: this.o.connectionId, timeUs: BigInt(evt.time_us) })
        .onConflictDoUpdate({ target: ingestCursors.connectionId, set: { timeUs: BigInt(evt.time_us), updatedAt: new Date() } });
    }).catch((err) => console.error("jetstream: handler error", err)); // cursor NOT advanced on failure
  }

  private async pollDids() {
    if (this.stopped) return;
    const dids = await this.o.getDids();
    if (!this.hasLiveSocket()) {
      // No socket yet — either the registry was empty at startup or a prior
      // connection dropped. Open one as soon as there's at least one DID to
      // filter on; an empty set still means "don't open the firehose".
      if (dids.length > 0) await this.connect(await this.readCursor());
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
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    await this.queue;
  }
}
