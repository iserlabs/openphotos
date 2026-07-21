import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { createTestDb, ingestCursors } from "@luminance/db";
import { JetstreamConsumer } from "./jetstream.js";

let wss: WebSocketServer; let consumer: JetstreamConsumer;
afterEach(async () => { await consumer?.stop(); wss?.close(); });

function fakeJetstream(onConn?: (url: string) => void) {
  wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws, req) => { onConn?.(req.url!); (wss as any).lastSocket = ws; });
  const port = (wss.address() as any).port;
  return `ws://127.0.0.1:${port}`;
}

describe("JetstreamConsumer", () => {
  it("delivers events and advances the cursor only after handling", async () => {
    const db = await createTestDb();
    const url = fakeJetstream();
    const seen: number[] = [];
    consumer = new JetstreamConsumer({
      db, url, connectionId: "main", collections: ["social.luminance.portfolio.photo"],
      getDids: async () => ["did:plc:kevin"],
      onEvent: async (e) => { seen.push(e.time_us); },
      onStaleCursor: async () => {},
    });
    await consumer.start();
    (wss as any).lastSocket.send(JSON.stringify({ did: "did:plc:kevin", time_us: 111, kind: "commit", commit: { operation: "create", collection: "social.luminance.portfolio.photo", rkey: "r", record: {} } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual([111]);
    const [cur] = await db.select().from(ingestCursors);
    expect(cur.timeUs).toBe(111n);
  });
  it("includes cursor and filters in the subscribe URL", async () => {
    const db = await createTestDb();
    await db.insert(ingestCursors).values({ connectionId: "main", timeUs: 999_000_000n });
    let seenUrl = "";
    const url = fakeJetstream((u) => { seenUrl = u; });
    consumer = new JetstreamConsumer({ db, url, connectionId: "main", collections: ["a.b.c"], getDids: async () => ["did:plc:x"], onEvent: async () => {}, onStaleCursor: async () => {} });
    await consumer.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(seenUrl).toContain("cursor=994000000"); // stored cursor minus 5s overlap
    expect(seenUrl).toContain("wantedCollections=a.b.c");
    expect(seenUrl).toContain("wantedDids=did%3Aplc%3Ax");
  });
  it("fires onStaleCursor when stored cursor is older than the replay window", async () => {
    const db = await createTestDb();
    await db.insert(ingestCursors).values({ connectionId: "main", timeUs: 1n }); // ancient
    let stale = false;
    const url = fakeJetstream();
    consumer = new JetstreamConsumer({ db, url, connectionId: "main", collections: [], getDids: async () => [], onEvent: async () => {}, onStaleCursor: async () => { stale = true; }, replayWindowUs: 1000n });
    await consumer.start();
    expect(stale).toBe(true);
  });

  it("reconnect() survives a transient getDids() failure without an unhandled rejection", async () => {
    const db = await createTestDb();
    let getDidsCalls = 0;
    const getDids = async () => {
      getDidsCalls++;
      if (getDidsCalls === 2) throw new Error("transient db blip"); // fails only on the reconnect attempt
      return ["did:plc:kevin"];
    };
    let connCount = 0;
    const url = fakeJetstream(() => { connCount++; });

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (err: unknown) => { unhandled.push(err); };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      consumer = new JetstreamConsumer({
        db, url, connectionId: "main", collections: [],
        getDids,
        onEvent: async () => {},
        onStaleCursor: async () => {},
      });
      await consumer.start();
      expect(connCount).toBe(1);

      (wss as any).lastSocket.terminate(); // force-close to trigger the close -> reconnect path

      // Worst case: first backoff (1000ms + <=500ms jitter) attempts a reconnect
      // whose getDids() throws, then a second backoff (2000ms + <=500ms jitter)
      // retries and succeeds. Budget comfortably above that ~4s ceiling.
      await new Promise((r) => setTimeout(r, 4500));

      expect(connCount).toBeGreaterThanOrEqual(2); // reconnect eventually succeeded
      expect(unhandled).toEqual([]); // the transient getDids() throw never escaped as a crash
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  }, 8000);

  it("stop() cancels a pending reconnect backoff so no new connection opens afterward", async () => {
    const db = await createTestDb();
    let connCount = 0;
    const url = fakeJetstream(() => { connCount++; });
    consumer = new JetstreamConsumer({
      db, url, connectionId: "main", collections: [],
      getDids: async () => ["did:plc:kevin"],
      onEvent: async () => {},
      onStaleCursor: async () => {},
    });
    await consumer.start();
    expect(connCount).toBe(1);

    (wss as any).lastSocket.terminate(); // force-close to trigger the close -> reconnect path
    // Let the close handler fire and reconnect() enter its backoff sleep (a
    // pending timer) before calling stop() -- that pending-timer window is
    // exactly what stop() must cancel. (Calling stop() with zero delay never
    // exercises the race: `stopped` would already be true before the close
    // event even reaches the client socket.)
    await new Promise((r) => setTimeout(r, 100));
    await consumer.stop();

    const countAfterStop = connCount;
    await new Promise((r) => setTimeout(r, 2500)); // > worst-case initial backoff (1000ms + 500ms jitter)
    expect(connCount).toBe(countAfterStop); // no reconnect opened a new connection after stop()
  }, 6000);
});
