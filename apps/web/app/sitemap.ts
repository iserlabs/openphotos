import type { MetadataRoute } from "next";
import { and, desc, eq, sql } from "drizzle-orm";
import { photographers, photos, photoOverrides } from "@luminance/db";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { splitAtUri } from "@/lib/queries";

// sitemap.js is cached by default unless it hits a request-time API; force it
// dynamic so a zero-env build never tries to read PUBLIC_URL/DATABASE_URL
// while prerendering, and so the sitemap always reflects live index state.
export const dynamic = "force-dynamic";

const MAX_PHOTOS = 5_000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const db = getDb();
  const base = env.PUBLIC_URL;

  const [photographerRows, photoRows] = await Promise.all([
    db
      .select({ handle: photographers.handle, registeredAt: photographers.registeredAt })
      .from(photographers)
      .where(eq(photographers.status, "active")),
    // One row per record (mediaIndex 0, which every source always produces),
    // matching the not-hidden/not-taken-down/active-photographer visibility
    // rules the photo detail page itself enforces.
    db
      .select({ atUri: photos.atUri, sortAt: photos.sortAt, indexedAt: photos.indexedAt })
      .from(photos)
      .innerJoin(photographers, eq(photos.did, photographers.did))
      .leftJoin(photoOverrides, and(eq(photoOverrides.atUri, photos.atUri), eq(photoOverrides.mediaIndex, photos.mediaIndex)))
      .where(and(
        eq(photos.mediaIndex, 0),
        eq(photographers.status, "active"),
        sql`coalesce(${photoOverrides.hidden}, false) = false`,
        sql`coalesce(${photoOverrides.takedown}, false) = false`,
      ))
      .orderBy(desc(photos.sortAt))
      .limit(MAX_PHOTOS),
  ]);

  const photographerEntries: MetadataRoute.Sitemap = photographerRows.map((p) => ({
    url: `${base}/${p.handle}`,
    lastModified: p.registeredAt,
  }));

  const photoEntries: MetadataRoute.Sitemap = photoRows.flatMap((p) => {
    const parts = splitAtUri(p.atUri);
    if (!parts) return [];
    return [{
      url: `${base}/photo/${encodeURIComponent(parts.did)}/${parts.collection}/${parts.rkey}`,
      lastModified: p.indexedAt,
    }];
  });

  return [{ url: base, lastModified: new Date() }, ...photographerEntries, ...photoEntries];
}
