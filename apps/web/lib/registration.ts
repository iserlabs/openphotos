import { and, eq } from "drizzle-orm";
import { photographers, photos, photoOverrides, type Db } from "@luminance/db";

/**
 * Upsert a photographer as `active` with a `pending` backfill. The ingestor's
 * poll picks up `backfillStatus:'pending'` rows automatically, so registration
 * (and later source-toggle changes) only need to write this row. Re-registering
 * an existing DID updates the handle + toggles in place instead of duplicating.
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
