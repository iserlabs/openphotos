import { isSensitive, splitAtUri } from "@/lib/queries";
import { PhotoCard } from "./photo-card";

/**
 * Structural subset of `typeof photos.$inferSelect` this grid needs — both
 * `feedPage`'s rows (photo + handle/displayName) and `getSeries`'s bare
 * photo rows satisfy it, so either can be passed directly.
 */
export interface GridPhoto {
  atUri: string;
  mediaIndex: number;
  did: string;
  blobCid: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  labels: string[];
  blurDataUrl: string | null;
}

/**
 * Good-enough justified look for v1 via CSS columns (no measured masonry).
 * Each tile links to the photo's detail page, deep-linked to its own
 * `#i{mediaIndex}` anchor so a tap on one image of a multi-image post lands
 * on that image specifically.
 */
export function PhotoGrid({
  items,
  counts,
}: {
  items: GridPhoto[];
  /**
   * Engagement counts keyed by post at-uri (spec §3) — one entry serves
   * every mediaIndex tile of the same post. Callers fetch this with a
   * SINGLE `engagementFor` call per page render (never per-tile); omitted
   * entirely (or missing a given key) simply renders that tile without an
   * overlay.
   */
  counts?: Map<string, { likeCount: number; replyCount: number }>;
}) {
  return (
    // `block` (not `columns-1`) below sm: a one-column multicol still creates
    // a CSS fragmentation context, and Chrome's LCP paint attribution inside
    // it lagged the actual pixels by ~4s on throttled mobile (Lighthouse
    // 80-vs-89 variance). Plain flow renders identically for one column.
    <div className="block gap-4 sm:columns-2 lg:columns-3">
      {items.map((p, i) => {
        const parts = splitAtUri(p.atUri);
        if (!parts) return null;
        const c = counts?.get(p.atUri);
        const imgBase = `/img/${encodeURIComponent(p.did)}/${encodeURIComponent(p.blobCid)}`;
        return (
          <PhotoCard
            key={`${p.atUri}#${p.mediaIndex}`}
            href={`/photo/${encodeURIComponent(parts.did)}/${parts.collection}/${parts.rkey}#i${p.mediaIndex}`}
            src={`${imgBase}/feed`}
            srcSet={`${imgBase}/thumb 512w, ${imgBase}/grid 768w, ${imgBase}/feed 1024w`}
            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
            alt={p.alt ?? ""}
            width={p.width}
            height={p.height}
            sensitive={isSensitive(p.labels)}
            priority={i < 2}
            eager={i >= 2 && i < 4}
            blurDataUrl={p.blurDataUrl}
            likeCount={c?.likeCount}
            replyCount={c?.replyCount}
          />
        );
      })}
    </div>
  );
}
