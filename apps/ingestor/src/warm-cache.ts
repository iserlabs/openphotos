import { and, eq, gt } from "drizzle-orm";
import { photos, type Db } from "@luminance/db";

/**
 * Cold-path killer for the image proxy: the first request for a fresh photo
 * pays PDS-fetch + sharp-encode (seconds). After indexing new rows, pre-request
 * the grid renditions so the CDN is warm before the first human arrives.
 * Best-effort and fire-and-forget: enabled only when a base URL is configured
 * (WARM_BASE_URL on Fly; unset in tests/dev).
 */
export async function warmNewPhotos(db: Db, did: string, opts: {
  baseUrl?: string;
  fetcher?: (url: string) => Promise<unknown>;
  sinceMs?: number;
  limit?: number;
} = {}): Promise<number> {
  const base = opts.baseUrl ?? process.env.WARM_BASE_URL;
  if (!base) return 0;
  const fetcher = opts.fetcher ?? (async (u: string) => { await fetch(u, { signal: AbortSignal.timeout(30_000) }); });
  const since = new Date(Date.now() - (opts.sinceMs ?? 15 * 60 * 1000));
  const rows = await db
    .select({ did: photos.did, blobCid: photos.blobCid })
    .from(photos)
    .where(and(eq(photos.did, did), gt(photos.indexedAt, since)))
    .limit(opts.limit ?? 60);
  let warmed = 0;
  for (const r of rows) {
    for (const preset of ["thumb", "grid", "feed"] as const) {
      try {
        await fetcher(`${base}/img/${encodeURIComponent(r.did)}/${encodeURIComponent(r.blobCid)}/${preset}`);
        warmed++;
      } catch {
        // best-effort; a failed warm just means the first viewer pays the cold path
      }
    }
  }
  return warmed;
}
