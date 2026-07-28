import { atUri, blobCid, selfLabelVals, parseDate, type Ctx, type MappedPhoto, type MappedSeries } from "./types.js";
import { clampSortAt } from "./luminance.js";

// social.opencontent.photograph (record): { image: blob, aspectRatio: {width,height} (required),
//   title?, description? (caption), alt?, exif? {camera,lens,focalLength,fNumber(string),shutterSpeed,iso(int)},
//   tags?[], license?, location?, capturedAt?, createdAt (required), labels? selfLabels }
//   — single image, one record = one work (spec: docs/superpowers/specs/2026-07-28-opencontent-portfolio-design.md §3).
//   No dedicated `location` column exists on `photos`; it's folded into the
//   existing `exif` jsonb bucket instead of adding a column for one field.
// social.opencontent.collection (record): { title (required), description?,
//   items: strongRef[] (required; array order IS display order), cover?: strongRef, createdAt (required) }
//   — like a Luminance series, the items[] array is the authoritative, ordered membership list.

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

export function mapOpencontentPhotograph(ctx: Ctx, record: any): MappedPhoto | null {
  const cid = blobCid(record?.image);
  if (!cid) return null;
  const ar = record?.aspectRatio;
  if (!isPositiveInt(ar?.width) || !isPositiveInt(ar?.height)) return null;
  const capturedAt = parseDate(record.capturedAt);
  const createdAt = parseDate(record.createdAt);
  const exif =
    record.exif || record.location
      ? { ...(record.exif ?? {}), ...(record.location ? { location: record.location } : {}) }
      : null;
  return {
    atUri: atUri(ctx), mediaIndex: 0, did: ctx.did, source: "opencontent",
    recordCid: ctx.cid, blobCid: cid,
    width: ar.width, height: ar.height,
    alt: record.alt ?? null, title: record.title ?? null, caption: record.description ?? null,
    capturedAt, createdAt, sortAt: clampSortAt(createdAt, ctx.indexedAt),
    exif, tags: record.tags ?? [], license: record.license ?? null,
    labels: selfLabelVals(record.labels), groupKey: null,
  };
}

export function mapOpencontentCollection(ctx: Ctx, record: any): MappedSeries | null {
  if (typeof record?.title !== "string" || !record.title) return null;
  if (!Array.isArray(record?.items)) return null;
  return {
    atUri: atUri(ctx), did: ctx.did, title: record.title, description: record.description ?? null,
    coverPhotoUri: record.cover?.uri ?? null, createdAt: parseDate(record.createdAt),
    items: record.items
      .map((it: any, i: number) => ({ photoUri: it?.uri, position: i }))
      .filter((it: { photoUri: unknown }) => typeof it.photoUri === "string" && it.photoUri.length > 0) as { photoUri: string; position: number }[],
    itemsAuthoritative: true, // an opencontent collection's items[] IS the membership + order, even when empty
  };
}
