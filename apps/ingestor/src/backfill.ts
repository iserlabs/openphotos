import { and, eq, inArray, like, ne, notInArray } from "drizzle-orm";
import { photographers, photos, series, seriesPhotos, tombstones, type Db } from "@luminance/db";
import {
  resolvePdsEndpoint as realResolve, safeJsonFetch, mapLuminancePhoto, mapBskyPost,
  mapGrainRecord, GRAIN_COLLECTIONS, mapOpencontentPhotograph, type Ctx,
} from "@luminance/atproto";
import {
  LUMINANCE_PHOTO, LUMINANCE_SERIES, LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE,
  OPENCONTENT_PHOTOGRAPH, OPENCONTENT_COLLECTION,
} from "@luminance/lexicons";
import type { Indexer } from "./indexer.js";
import { warmNewPhotos } from "./warm-cache.js";

const MAX_PER_COLLECTION = 5000; // spec §9
const WATCHED = [
  LUMINANCE_PHOTO, LUMINANCE_SERIES, LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE, ...GRAIN_COLLECTIONS,
  OPENCONTENT_PHOTOGRAPH, OPENCONTENT_COLLECTION,
];

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
      // Purge-race guard: a deregistration (whose purge deletes this DID's
      // rows) can land while this walk is mid-flight — without this check the
      // walk would resurrect the purged rows. Re-read status per collection;
      // abort silently on deregistration (the purge is the newer intent).
      const [cur] = await db.select({ status: photographers.status }).from(photographers).where(eq(photographers.did, did));
      if (!cur || cur.status === "deregistered") return;
      let cursor: string | undefined; let count = 0;
      const seen = new Set<string>();
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
          seen.add(String(r.uri));
          const ctx: Ctx = { did, collection, rkey, cid: r.cid, indexedAt: new Date() };
          await applyOne(indexer, ctx, r.value);
          count++;
        }
        cursor = page.cursor;
        await sleep(opts.retryDelayMs ?? 250); // throttle (spec §9)
      } while (cursor && count < cap);
      // Reconciliation: the walked repo is the source of truth. Rows whose
      // records vanished upstream (delete events the firehose never delivered
      // — observed in production: Jetstream lagging a PDS by 30+ minutes) are
      // removed here. Only when the walk saw the WHOLE collection: a
      // cap-truncated walk proves nothing about unseen records.
      const truncated = Boolean(cursor) && count >= cap;
      if (!truncated) await reconcileCollection(db, did, collection, seen);
    }
    await db.delete(tombstones).where(like(tombstones.atUri, `at://${did}/%`)); // prune only this DID's tombstones — concurrent backfills of other DIDs must keep theirs (spec §9)
    await db.update(photographers).set({ backfillStatus: "complete" }).where(eq(photographers.did, did));
  } catch (err) {
    console.error("backfill failed", { did, err: String(err) });
    await db.update(photographers).set({ backfillStatus: "failed" }).where(eq(photographers.did, did));
  }
}

const PHOTO_SOURCE_BY_COLLECTION: Record<string, "luminance" | "bsky" | "grain" | "opencontent"> = {
  [LUMINANCE_PHOTO]: "luminance",
  [BSKY_POST]: "bsky",
  "social.grain.photo": "grain",
  [OPENCONTENT_PHOTOGRAPH]: "opencontent",
};

async function reconcileCollection(db: Db, did: string, collection: string, seen: Set<string>) {
  const uris = [...seen];
  const source = PHOTO_SOURCE_BY_COLLECTION[collection];
  if (source) {
    const where = uris.length
      ? and(eq(photos.did, did), eq(photos.source, source), notInArray(photos.atUri, uris))
      : and(eq(photos.did, did), eq(photos.source, source));
    await db.delete(photos).where(where);
    return;
  }
  if (collection === LUMINANCE_SERIES || collection === "social.grain.gallery" || collection === OPENCONTENT_COLLECTION) {
    const pattern = `at://${did}/${collection}/%`;
    const where = uris.length
      ? and(eq(series.did, did), like(series.atUri, pattern), notInArray(series.atUri, uris))
      : and(eq(series.did, did), like(series.atUri, pattern));
    const stale = await db.select({ atUri: series.atUri }).from(series).where(where);
    if (stale.length) {
      const staleUris = stale.map((s) => s.atUri);
      await db.transaction(async (tx) => {
        await tx.delete(seriesPhotos).where(inArray(seriesPhotos.seriesUri, staleUris));
        await tx.delete(series).where(inArray(series.atUri, staleUris));
      });
    }
    return;
  }
  if (collection === "social.grain.gallery.item") {
    const pattern = `at://${did}/${collection}/%`;
    const where = uris.length
      ? and(like(seriesPhotos.itemUri, pattern), notInArray(seriesPhotos.itemUri, uris))
      : like(seriesPhotos.itemUri, pattern);
    await db.delete(seriesPhotos).where(where);
    return;
  }
  // profile collections: upsert-only, nothing to reconcile
}

async function applyOne(indexer: Indexer, ctx: Ctx, record: any) {
  const { collection } = ctx;
  if (collection === LUMINANCE_PHOTO) {
    const m = mapLuminancePhoto(ctx, record);
    if (m) await indexer.applyPhotoRows([m], { respectTombstones: true });
  } else if (collection === OPENCONTENT_PHOTOGRAPH) {
    const m = mapOpencontentPhotograph(ctx, record);
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

export function startBackfillLoop(db: Db, indexer: Indexer, intervalMs = 10_000, reconcileIntervalMs = 15 * 60 * 1000) {
  // Periodic reconciliation: the firehose is best-effort delivery (observed in
  // production: Jetstream lagging a PDS by 30+ min, dropping deletes/creates).
  // Re-arming every active photographer every 15 min bounds staleness at
  // ~reconcileIntervalMs regardless of upstream health — PDS truth wins.
  let lastReconcile = Date.now();
  return setInterval(async () => {
    try {
      if (Date.now() - lastReconcile >= reconcileIntervalMs) {
        lastReconcile = Date.now();
        await db.update(photographers).set({ backfillStatus: "pending" }).where(eq(photographers.status, "active"));
      }
      const pending = await db.select().from(photographers)
        .where(and(eq(photographers.backfillStatus, "pending"), ne(photographers.status, "deregistered")));
      for (const p of pending) {
        await runBackfill(db, indexer, p.did);
        // Pre-request fresh renditions so the first viewer hits the CDN, not
        // a cold PDS-fetch+encode (no-op unless WARM_BASE_URL is set).
        void warmNewPhotos(db, p.did).catch(() => {});
      }
    } catch (err) {
      console.error("backfill loop: tick failed, will retry next interval", err);
    }
  }, intervalMs);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
