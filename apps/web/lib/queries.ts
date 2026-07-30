import { and, eq, asc, sql } from "drizzle-orm";
import { photos, photographers, series, seriesPhotos, photoOverrides, type Db } from "@openphotos/db";

export const LABEL_BLUR = ["nudity", "sexual", "porn", "graphic-media"];

/** True when any of a photo's self-labels should be blurred client-side. */
export function isSensitive(labels: string[]): boolean {
  return labels.some((l) => LABEL_BLUR.includes(l));
}

/** at://{did}/{collection}/{rkey} — inverse of {@link splitAtUri}. */
export function buildAtUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`;
}

/** Pulls {did, collection, rkey} back out of an at-uri, for building page links. */
export function splitAtUri(atUri: string): { did: string; collection: string; rkey: string } | null {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(atUri);
  return m ? { did: m[1], collection: m[2], rkey: m[3] } : null;
}

export async function getPhotographerByHandle(db: Db, handle: string) {
  const [p] = await db.select().from(photographers).where(and(eq(photographers.handle, handle), eq(photographers.status, "active")));
  return p ?? null;
}
/** DID-keyed twin of {@link getPhotographerByHandle} — backs the permanent
 * `/did:…` profile fallback (bookmarked handle URLs orphan on handle change;
 * the DID never does). */
export async function getPhotographerByDid(db: Db, did: string) {
  const [p] = await db.select().from(photographers).where(and(eq(photographers.did, did), eq(photographers.status, "active")));
  return p ?? null;
}
export async function getPhotoRecord(db: Db, atUri: string) {
  const rows = await db.select({ photo: photos, hidden: photoOverrides.hidden, takedown: photoOverrides.takedown })
    .from(photos)
    .leftJoin(photoOverrides, and(eq(photoOverrides.atUri, photos.atUri), eq(photoOverrides.mediaIndex, photos.mediaIndex)))
    .where(eq(photos.atUri, atUri))
    .orderBy(asc(photos.mediaIndex));
  const items = rows.filter((r) => !r.hidden && !r.takedown).map((r) => r.photo);
  if (!items.length) return null;
  const [ph] = await db.select().from(photographers).where(and(eq(photographers.did, items[0].did), eq(photographers.status, "active")));
  return ph ? { items, photographer: ph } : null;
}
export async function getSeries(db: Db, atUri: string) {
  const [s] = await db.select().from(series).where(eq(series.atUri, atUri));
  if (!s) return null;
  const items = await db.select({ photo: photos })
    .from(seriesPhotos)
    .innerJoin(photos, and(eq(photos.atUri, seriesPhotos.photoUri), eq(photos.mediaIndex, sql`0`)))
    .leftJoin(photoOverrides, and(eq(photoOverrides.atUri, photos.atUri), eq(photoOverrides.mediaIndex, photos.mediaIndex)))
    .where(and(
      eq(seriesPhotos.seriesUri, atUri),
      sql`coalesce(${photoOverrides.hidden}, false) = false`,
      sql`coalesce(${photoOverrides.takedown}, false) = false`,
    ))
    .orderBy(asc(seriesPhotos.position));
  return { series: s, items: items.map((i) => i.photo) };
}
