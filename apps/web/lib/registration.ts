import { and, eq, inArray, like } from "drizzle-orm";
import { photographers, photos, photoOverrides, series, seriesPhotos, type Db } from "@openphotos/db";

/**
 * Grain galleries are the only `series` rows sourced from a toggle-able source.
 * Their at-uri is `at://{did}/social.grain.gallery/{rkey}` — the trailing slash
 * after the NSID keeps this from also matching `social.grain.gallery.item`.
 */
const GRAIN_GALLERY_ATURI_LIKE = "%/social.grain.gallery/%";

/**
 * Drop already-indexed rows for any source the photographer has turned off, so
 * disabling a source deletes its content instead of merely halting new ingest
 * (consent must apply retroactively). Callers set `backfillStatus:'pending'`
 * separately when a source is re-enabled, which re-scans it. The photos index
 * is rebuildable, so deleting here is safe.
 */
async function cleanupToggledOffSources(
  db: Db,
  did: string,
  o: { includeBsky: boolean; includeGrain: boolean },
) {
  if (!o.includeBsky) {
    await db.delete(photos).where(and(eq(photos.did, did), eq(photos.source, "bsky")));
  }
  if (!o.includeGrain) {
    await db.delete(photos).where(and(eq(photos.did, did), eq(photos.source, "grain")));
    // Grain-sourced series are galleries; delete them and their membership rows.
    const grainSeries = await db
      .select({ atUri: series.atUri })
      .from(series)
      .where(and(eq(series.did, did), like(series.atUri, GRAIN_GALLERY_ATURI_LIKE)));
    if (grainSeries.length) {
      const uris = grainSeries.map((s) => s.atUri);
      await db.delete(seriesPhotos).where(inArray(seriesPhotos.seriesUri, uris));
      await db.delete(series).where(inArray(series.atUri, uris));
    }
  }
}

/**
 * Upsert a photographer as `active` with a `pending` backfill. The ingestor's
 * poll picks up `backfillStatus:'pending'` rows automatically, so registration
 * only needs to write this row. Re-registering an existing DID updates the
 * handle + toggles in place instead of duplicating. This is an explicit
 * user-consent flow (/register/sources), so it may reactivate — but any source
 * turned off here still has its existing rows purged.
 */
export async function completeRegistration(
  db: Db,
  o: { did: string; handle: string; includeBsky: boolean; includeGrain: boolean },
) {
  await db
    .insert(photographers)
    .values({
      did: o.did,
      handle: o.handle,
      includeBsky: o.includeBsky,
      includeGrain: o.includeGrain,
      status: "active",
      backfillStatus: "pending",
    })
    .onConflictDoUpdate({
      target: photographers.did,
      set: {
        handle: o.handle,
        includeBsky: o.includeBsky,
        includeGrain: o.includeGrain,
        status: "active",
        backfillStatus: "pending",
      },
    });
  await cleanupToggledOffSources(db, o.did, o);
}

/**
 * Update ONLY the two source toggles for an already-registered photographer
 * (settings flow). Never touches `status` — so it can't implicitly reactivate a
 * `deregistered`/`pending_review` account the way an upsert would. Re-arms the
 * backfill so a re-enabled source gets rescanned, and purges rows for any source
 * turned off.
 */
export async function updateSourceToggles(
  db: Db,
  did: string,
  o: { includeBsky: boolean; includeGrain: boolean },
) {
  await db
    .update(photographers)
    .set({ includeBsky: o.includeBsky, includeGrain: o.includeGrain, backfillStatus: "pending" })
    .where(eq(photographers.did, did));
  await cleanupToggledOffSources(db, did, o);
}

/**
 * Set (or clear) the `hidden` curation override for one photo — but only if the
 * caller owns it. Ownership is re-checked against the index here so the calling
 * server action can trust the DID from the session and pass only the photo
 * reference from the (untrusted) client.
 */
export async function setHiddenForDid(
  db: Db,
  did: string,
  atUri: string,
  mediaIndex: number,
  hidden: boolean,
) {
  const [row] = await db
    .select()
    .from(photos)
    .where(and(eq(photos.atUri, atUri), eq(photos.mediaIndex, mediaIndex)));
  if (!row || row.did !== did) throw new Error("not your photo");
  await db
    .insert(photoOverrides)
    .values({ atUri, mediaIndex, hidden })
    .onConflictDoUpdate({
      target: [photoOverrides.atUri, photoOverrides.mediaIndex],
      set: { hidden, updatedAt: new Date() },
    });
}

/**
 * Deregister a photographer: drop their rows from the (rebuildable) photo index
 * and mark the durable photographer row `deregistered`. Curation overrides
 * (hides/takedowns) are intentionally left intact so they survive re-registration
 * and re-backfill.
 */
export async function deregisterDid(db: Db, did: string) {
  await db.delete(photos).where(eq(photos.did, did));
  await db.update(photographers).set({ status: "deregistered" }).where(eq(photographers.did, did));
}

/**
 * Admin takedown of a single photo — records a durable override (survives
 * re-backfill) that suppresses the photo regardless of the owner's own
 * curation. Caller must have already verified admin authority.
 */
export async function adminTakedown(db: Db, atUri: string, mediaIndex: number, reason: string) {
  await db
    .insert(photoOverrides)
    .values({ atUri, mediaIndex, takedown: true, reason })
    .onConflictDoUpdate({
      target: [photoOverrides.atUri, photoOverrides.mediaIndex],
      set: { takedown: true, reason, updatedAt: new Date() },
    });
}
