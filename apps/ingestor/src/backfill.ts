import { and, eq, like, ne } from "drizzle-orm";
import { photographers, tombstones, type Db } from "@luminance/db";
import {
  resolvePdsEndpoint as realResolve, safeJsonFetch, mapLuminancePhoto, mapBskyPost,
  mapGrainRecord, GRAIN_COLLECTIONS, type Ctx,
} from "@luminance/atproto";
import { LUMINANCE_PHOTO, LUMINANCE_SERIES, LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE } from "@luminance/lexicons";
import type { Indexer } from "./indexer.js";

const MAX_PER_COLLECTION = 5000; // spec §9
const WATCHED = [LUMINANCE_PHOTO, LUMINANCE_SERIES, LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE, ...GRAIN_COLLECTIONS];

export async function runBackfill(db: Db, indexer: Indexer, did: string, opts: {
  fetchJson?: (url: string) => Promise<unknown>; resolvePds?: (did: string) => Promise<string>;
  maxPerCollection?: number; maxAttempts?: number; retryDelayMs?: number;
} = {}) {
  const fetchJson = opts.fetchJson ?? safeJsonFetch;
  const resolvePds = opts.resolvePds ?? realResolve;
  const cap = opts.maxPerCollection ?? MAX_PER_COLLECTION;
  const attempts = opts.maxAttempts ?? 5;
  await db.update(photographers).set({ backfillStatus: "running" }).where(eq(photographers.did, did));
  try {
    // Source toggles gate whole collections here instead of filtering rows
    // after mapping: skipping the walk entirely also saves the PDS request
    // for a disabled source (spec §7 toggles), and keeps applyOne's direct
    // applyPhotoRows calls (which need respectTombstones, not a toggle check)
    // untouched.
    const [ph] = await db.select().from(photographers).where(eq(photographers.did, did));
    const includeBsky = ph?.includeBsky ?? true;
    const includeGrain = ph?.includeGrain ?? true;
    const collections = WATCHED.filter((c) => {
      if (c === BSKY_POST && !includeBsky) return false;
      if (GRAIN_COLLECTIONS.includes(c) && !includeGrain) return false;
      return true;
    });

    let pds = "";
    for (let a = 1; ; a++) {
      try { pds = await resolvePds(did); break; }
      catch (e) { if (a >= attempts) throw e; await sleep(opts.retryDelayMs ?? 1000 * 2 ** a); }
    }
    for (const collection of collections) {
      let cursor: string | undefined; let count = 0;
      do {
        const u = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`);
        u.searchParams.set("repo", did); u.searchParams.set("collection", collection); u.searchParams.set("limit", "100");
        if (cursor) u.searchParams.set("cursor", cursor);
        let page: any;
        for (let a = 1; ; a++) {
          try { page = await fetchJson(u.toString()); break; }
          catch (e) { if (a >= attempts) throw e; await sleep(opts.retryDelayMs ?? 1000 * 2 ** a); }
        }
        for (const r of page.records ?? []) {
          const rkey = String(r.uri).split("/").pop()!;
          const ctx: Ctx = { did, collection, rkey, cid: r.cid, indexedAt: new Date() };
          await applyOne(indexer, ctx, r.value);
          count++;
        }
        cursor = page.cursor;
        await sleep(opts.retryDelayMs ?? 250); // throttle (spec §9)
      } while (cursor && count < cap);
    }
    await db.delete(tombstones).where(like(tombstones.atUri, `at://${did}/%`)); // prune only this DID's tombstones — concurrent backfills of other DIDs must keep theirs (spec §9)
    await db.update(photographers).set({ backfillStatus: "complete" }).where(eq(photographers.did, did));
  } catch (err) {
    console.error("backfill failed", { did, err: String(err) });
    await db.update(photographers).set({ backfillStatus: "failed" }).where(eq(photographers.did, did));
  }
}

async function applyOne(indexer: Indexer, ctx: Ctx, record: any) {
  const { collection } = ctx;
  if (collection === LUMINANCE_PHOTO) {
    const m = mapLuminancePhoto(ctx, record);
    if (m) await indexer.applyPhotoRows([m], { respectTombstones: true });
  } else if (collection === BSKY_POST) {
    await indexer.applyPhotoRows(mapBskyPost(ctx, record), { respectTombstones: true });
  } else if (GRAIN_COLLECTIONS.includes(collection)) {
    const m = mapGrainRecord(ctx, record);
    if (m?.photo) await indexer.applyPhotoRows([m.photo], { respectTombstones: true });
    // series/items reuse the live-path handlers (itemUri/itemsAuthoritative semantics):
    if (m?.series || m?.seriesItem) {
      await indexer.handleEvent({ did: ctx.did, time_us: 0, kind: "commit", commit: { operation: "create", collection, rkey: ctx.rkey, cid: ctx.cid, record } });
    }
  } else {
    await indexer.handleEvent({ did: ctx.did, time_us: 0, kind: "commit", commit: { operation: "create", collection, rkey: ctx.rkey, cid: ctx.cid, record } });
  }
}

export function startBackfillLoop(db: Db, indexer: Indexer, intervalMs = 10_000) {
  return setInterval(async () => {
    try {
      const pending = await db.select().from(photographers)
        .where(and(eq(photographers.backfillStatus, "pending"), ne(photographers.status, "deregistered")));
      for (const p of pending) await runBackfill(db, indexer, p.did);
    } catch (err) {
      console.error("backfill loop: tick failed, will retry next interval", err);
    }
  }, intervalMs);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
