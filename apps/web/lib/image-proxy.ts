import { and, eq, notInArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { photos, photographers, photoOverrides, type Db } from "@luminance/db";
import { resolvePdsEndpoint, safeFetch } from "@luminance/atproto";

export const PRESETS = { thumb: 512, feed: 1024, full: 2048 } as const;
export type Preset = keyof typeof PRESETS;

interface Deps {
  fetchBlob?: (did: string, cid: string) => Promise<Buffer>;
}

async function defaultFetchBlob(did: string, cid: string): Promise<Buffer> {
  const pds = await resolvePdsEndpoint(did);
  const url = `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
  // safeFetch = SSRF guard + DNS pinned through the guarded agent (TOCTOU-closed)
  const res = await safeFetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`getBlob ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function proxyImage(
  db: Db,
  req: { did: string; cid: string; preset: Preset; accept: string },
  deps: Deps = {},
) {
  const width = Object.prototype.hasOwnProperty.call(PRESETS, req.preset) ? PRESETS[req.preset] : undefined;
  if (!width) return { status: 400, cacheControl: "public, max-age=3600" };

  // Allowlist: only blobs the index references may be proxied (spec §11).
  // Both branches join photographers and exclude removed accounts
  // ('deregistered'/'takedown') so a moderation/opt-out action reaches the CDN
  // layer too; the photo branch also left-joins overrides to drop taken-down
  // photos. 404 before any upstream fetch if neither matches.
  const LIVE_STATUSES = notInArray(photographers.status, ["deregistered", "takedown"]);
  const [photoHit] = await db
    .select({ cid: photos.blobCid })
    .from(photos)
    .innerJoin(photographers, eq(photos.did, photographers.did))
    .leftJoin(photoOverrides, and(eq(photoOverrides.atUri, photos.atUri), eq(photoOverrides.mediaIndex, photos.mediaIndex)))
    .where(and(
      eq(photos.blobCid, req.cid),
      eq(photos.did, req.did),
      LIVE_STATUSES,
      sql`coalesce(${photoOverrides.takedown}, false) = false`,
    ))
    .limit(1);

  let allowed = Boolean(photoHit);
  if (!allowed) {
    const [avatarHit] = await db
      .select({ cid: photographers.avatarCid })
      .from(photographers)
      .where(and(eq(photographers.avatarCid, req.cid), eq(photographers.did, req.did), LIVE_STATUSES))
      .limit(1);
    allowed = Boolean(avatarHit);
  }
  if (!allowed) return { status: 404, cacheControl: "public, max-age=300" };

  try {
    const buf = await (deps.fetchBlob ?? defaultFetchBlob)(req.did, req.cid);
    const wantsAvif = req.accept.includes("image/avif");
    const wantsWebp = req.accept.includes("image/webp");
    let pipe = sharp(buf).rotate().resize({ width, withoutEnlargement: true });
    pipe = wantsAvif ? pipe.avif({ quality: 70 }) : wantsWebp ? pipe.webp({ quality: 82 }) : pipe.jpeg({ quality: 85 });
    return {
      status: 200,
      body: await pipe.toBuffer(),
      contentType: wantsAvif ? "image/avif" : wantsWebp ? "image/webp" : "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable",
    };
  } catch {
    return { status: 502, cacheControl: "public, max-age=30" }; // negative cache (spec §12)
  }
}
