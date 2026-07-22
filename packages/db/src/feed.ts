import { and, eq, sql, desc } from "drizzle-orm";
import { photos, photographers, photoOverrides } from "./schema.js";
import type { Db } from "./client.js";

export type FeedRow = typeof photos.$inferSelect & { handle: string; displayName: string | null };

export function encodeCursor(r: { sortAt: Date; atUri: string; mediaIndex: number }): string {
  return Buffer.from(JSON.stringify([r.sortAt.toISOString(), r.atUri, r.mediaIndex])).toString("base64url");
}
export function decodeCursor(c: string): { sortAt: Date; atUri: string; mediaIndex: number } {
  const [s, u, m] = JSON.parse(Buffer.from(c, "base64url").toString());
  return { sortAt: new Date(s), atUri: u, mediaIndex: m };
}

export async function feedPage(db: Db, opts: { limit: number; cursor?: string; did?: string }) {
  const { limit } = opts;
  let cur: { sortAt: Date; atUri: string; mediaIndex: number } | null = null;
  if (opts.cursor) {
    try {
      cur = decodeCursor(opts.cursor);
    } catch {
      // Malformed/undecodable cursor (bad base64, corrupt JSON, tampered
      // query param) — treat as "no cursor" instead of crashing the feed.
      cur = null;
    }
  }
  const rows = await db
    .select({ photo: photos, handle: photographers.handle, displayName: photographers.displayName })
    .from(photos)
    .innerJoin(photographers, eq(photos.did, photographers.did))
    .leftJoin(photoOverrides, and(eq(photoOverrides.atUri, photos.atUri), eq(photoOverrides.mediaIndex, photos.mediaIndex)))
    .where(and(
      eq(photographers.status, "active"),
      sql`coalesce(${photoOverrides.hidden}, false) = false`,
      sql`coalesce(${photoOverrides.takedown}, false) = false`,
      opts.did ? eq(photos.did, opts.did) : sql`true`,
      cur ? sql`(${photos.sortAt}, ${photos.atUri}, ${photos.mediaIndex}) < (${cur.sortAt}, ${cur.atUri}, ${cur.mediaIndex})` : sql`true`,
    ))
    .orderBy(desc(photos.sortAt), desc(photos.atUri), desc(photos.mediaIndex))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map((r) => ({ ...r.photo, handle: r.handle, displayName: r.displayName }));
  const cursor = rows.length > limit ? encodeCursor(items[items.length - 1]) : null;
  return { items, cursor };
}
