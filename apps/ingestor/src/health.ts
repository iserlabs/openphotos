import { createServer, type Server } from "node:http";

export interface Stats { indexed: number; skipped: number; deleted: number }

/**
 * Tiny liveness endpoint for the ingestor. `stats` is a live reference to
 * `Indexer.stats` (a mutable object updated in place), so every request
 * reflects the current counters without needing a getter callback.
 */
export function startHealthServer(stats: Stats, port: number): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, stats }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  server.listen(port);
  return server;
}
