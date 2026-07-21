import { atUri, blobCid, selfLabelVals, parseDate, type Ctx, type MappedPhoto, type MappedSeries } from "./types.js";
import { clampSortAt } from "./luminance.js";

// VERIFIED against grainsocial/grain lexicons (github.com/grainsocial/grain, lexicons/social/grain/**)
// on 2026-07-21, and against a real Grain user's PDS records (repo describeRepo + listRecords) —
// see task-7-report.md for full evidence. Update these if Grain versions their lexicons.
//
// social.grain.photo (record): { photo: blob, alt?: string, aspectRatio: {width,height}, createdAt }
//   — blob field is `photo`, not `image`; no title/caption/labels on the photo record itself.
// social.grain.gallery (record): { title, description?, facets?, labels?, location?, address?,
//   updatedAt?, createdAt } — no coverPhoto/items field; gallery membership is a separate collection.
// social.grain.gallery.item (record): { gallery: at-uri string, item: at-uri string,
//   position?: integer (default 0), createdAt } — plain at-uri strings, not strongRefs.
export const GRAIN_PHOTO = "social.grain.photo";
export const GRAIN_GALLERY = "social.grain.gallery";
export const GRAIN_GALLERY_ITEM = "social.grain.gallery.item";
export const GRAIN_COLLECTIONS = [GRAIN_PHOTO, GRAIN_GALLERY, GRAIN_GALLERY_ITEM];

export function mapGrainRecord(
  ctx: Ctx,
  record: any,
): { photo?: MappedPhoto; series?: MappedSeries; seriesItem?: { seriesUri: string; photoUri: string; position: number } } | null {
  if (ctx.collection === GRAIN_PHOTO) {
    const cid = blobCid(record?.photo);
    if (!cid) return null;
    const createdAt = parseDate(record.createdAt);
    const photo: MappedPhoto = {
      atUri: atUri(ctx), mediaIndex: 0, did: ctx.did, source: "grain", recordCid: ctx.cid, blobCid: cid,
      width: record.aspectRatio?.width ?? null, height: record.aspectRatio?.height ?? null,
      alt: record.alt ?? null, title: null, caption: null, capturedAt: null, createdAt,
      sortAt: clampSortAt(createdAt, ctx.indexedAt), exif: null, tags: [], license: null,
      labels: selfLabelVals(record.labels), groupKey: null,
    };
    return { photo };
  }
  if (ctx.collection === GRAIN_GALLERY) {
    if (typeof record?.title !== "string" || !record.title) return null;
    const series: MappedSeries = {
      atUri: atUri(ctx), did: ctx.did, title: record.title,
      description: record.description ?? null, coverPhotoUri: null,
      createdAt: parseDate(record.createdAt), items: [],
    };
    return { series };
  }
  if (ctx.collection === GRAIN_GALLERY_ITEM) {
    if (typeof record?.gallery !== "string" || typeof record?.item !== "string") return null;
    const position = typeof record.position === "number" ? record.position : 0;
    return { seriesItem: { seriesUri: record.gallery, photoUri: record.item, position } };
  }
  return null;
}
