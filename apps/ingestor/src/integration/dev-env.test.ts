import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TestNetworkNoAppView } from "@atproto/dev-env";
import type { AtpAgent } from "@atproto/api";
import { createTestDb, photographers, photos } from "@luminance/db";
import { Indexer } from "../indexer.js";
import { runBackfill } from "../backfill.js";
import { OPENCONTENT_PHOTOGRAPH } from "@luminance/lexicons";

// ── Integration gate (spec §13) + rebuild drill (success criterion 3) ─────────
// Writes REAL records into a REAL local PDS (@atproto/dev-env), really backfills
// them over HTTP, honors a live delete, then drops the index and rebuilds it to
// convergence. Excluded from `pnpm test`; run with `test:integration`.
//
// Deviations from the task brief (installed reality governs):
//  1. dev-env 0.5.36's TestNetworkNoAppView spins up a SQLite-native PDS in a
//     temp dir — NO Docker/Postgres. The brief's `dbPostgresSchema` param is
//     ignored by `TestNetworkNoAppView.create` (it only forwards `plc`/`pds`),
//     so we call `create()` with no args.
//  2. `network.pds.getClient()` returns the new `@atproto/lex` Client; the
//     authenticated AtpAgent API the test needs (session/uploadBlob/putRecord)
//     lives on `network.pds.getAgent()`. We use getAgent().
//  3. The dev PDS runs with `disableSsrfProtection: true` and serves plain HTTP
//     on localhost — which is exactly why we inject a test-local `fetchJson`
//     (plain `fetch`) and `resolvePds` into runBackfill instead of the
//     production `safeJsonFetch`, whose SSRF guard would (correctly) refuse it.
//  4. `putRecord` uses `validate: false`: the opencontent lexicon isn't registered
//     on the dev PDS. (Unknown NSIDs are skipped by the PDS's default validation
//     anyway, but we're explicit.)

let network: TestNetworkNoAppView;
let agent: AtpAgent;
let did: string;

beforeAll(async () => {
  network = await TestNetworkNoAppView.create();
  agent = network.pds.getAgent();
  // dev-env serviceHandleDomains include ".test" — handle must end in one.
  await agent.createAccount({ handle: "kevin.test", email: "k@test.com", password: "password" });
  did = agent.session!.did;
}, 120_000);

afterAll(async () => {
  await network?.close();
});

// Minimal but valid 1x1 JPEG — uploadBlob only needs bytes + a mime hint.
const ONE_PX_JPEG =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==";

async function writePhoto(rkey: string) {
  const img = Buffer.from(ONE_PX_JPEG, "base64");
  const up = await agent.uploadBlob(img, { encoding: "image/jpeg" });
  await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: OPENCONTENT_PHOTOGRAPH,
    rkey,
    validate: false, // opencontent lexicon isn't registered on the dev PDS
    record: {
      $type: OPENCONTENT_PHOTOGRAPH, image: up.data.blob,
      aspectRatio: { width: 1, height: 1 },
      createdAt: new Date().toISOString(),
    },
  });
}

describe("foundation end-to-end (dev-env)", () => {
  it("backfills real records from a real PDS, honors deletes, and passes the rebuild drill", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did, handle: "kevin.test" });
    const indexer = new Indexer(db);

    await writePhoto("p1");
    await writePhoto("p2");

    // Test-local fetcher: the dev PDS is http://localhost, which the production
    // safeJsonFetch would (rightly) refuse. This bypass lives ONLY in the test.
    const fetchJson = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    };
    const resolvePds = async () => network.pds.url;

    // ── Real backfill ────────────────────────────────────────────────────────
    await runBackfill(db, indexer, did, { fetchJson, resolvePds });
    expect(await db.select().from(photos)).toHaveLength(2);
    const [ph] = await db.select().from(photographers);
    expect(ph.backfillStatus).toBe("complete");

    // ── Live delete ──────────────────────────────────────────────────────────
    await agent.com.atproto.repo.deleteRecord({ repo: did, collection: OPENCONTENT_PHOTOGRAPH, rkey: "p1" });
    await indexer.handleEvent({
      did,
      time_us: Date.now() * 1000,
      kind: "commit",
      commit: { operation: "delete", collection: OPENCONTENT_PHOTOGRAPH, rkey: "p1" },
    });
    expect(await db.select().from(photos)).toHaveLength(1);

    // ── Rebuild drill (success criterion 3): truncate index, re-backfill, converge ─
    await db.delete(photos);
    await db.update(photographers).set({ backfillStatus: "pending" });
    await runBackfill(db, indexer, did, { fetchJson, resolvePds });
    const rows = await db.select().from(photos);
    expect(rows).toHaveLength(1);
    expect(rows[0].atUri).toContain("/p2"); // p1 stayed deleted; only p2 rebuilt
  }, 120_000);
});
