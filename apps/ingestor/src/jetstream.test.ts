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
});
