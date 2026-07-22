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
}

/**
 * Good-enough justified look for v1 via CSS columns (no measured masonry).
 * Each tile links to the photo's detail page, deep-linked to its own
 * `#i{mediaIndex}` anchor so a tap on one image of a multi-image post lands
 * on that image specifically.
 */
export function PhotoGrid({ items }: { items: GridPhoto[] }) {
  return (
    <div className="columns-1 gap-4 sm:columns-2 lg:columns-3">
      {items.map((p, i) => {
        const parts = splitAtUri(p.atUri);
        if (!parts) return null;
        return (
          <PhotoCard
            key={`${p.atUri}#${p.mediaIndex}`}
            href={`/photo/${encodeURIComponent(parts.did)}/${parts.collection}/${parts.rkey}#i${p.mediaIndex}`}
            src={`/img/${encodeURIComponent(p.did)}/${encodeURIComponent(p.blobCid)}/feed`}
            alt={p.alt ?? ""}
            width={p.width}
            height={p.height}
            sensitive={isSensitive(p.labels)}
            priority={i < 4}
          />
        );
      })}
    </div>
  );
}
