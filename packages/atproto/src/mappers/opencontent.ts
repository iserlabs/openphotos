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
//   — like a OpenPhotos series, the items[] array is the authoritative, ordered membership list.

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

// Untrusted-publisher hardening: opencontent records can originate from ANY
// publisher, not just the hub's own client, so exif/tags/items must be
// coerced member-by-member into primitives *here*, at the ingest boundary,
// before they ever reach the `photos`/`series` jsonb columns. A non-primitive
// member (e.g. exif.iso: {}) reaching the direct render in
// apps/web/app/photo/[did]/[collection]/[rkey]/page.tsx throws "Objects are
// not valid as a React child" — a per-record 500.
const EXIF_STRING_KEYS = ["camera", "lens", "focalLength", "fNumber", "shutterSpeed"] as const;
const MAX_EXIF_STRING_BYTES = 256;
const MAX_LOCATION_BYTES = 800;
const MAX_TAGS = 20;
const MAX_TAG_BYTES = 256;
const MAX_COLLECTION_ITEMS = 500;

function clampBytes(s: string, maxBytes: number): string {
  return Buffer.byteLength(s, "utf8") <= maxBytes ? s : Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8");
}

function buildExif(rawExif: unknown, rawLocation: unknown): Record<string, string | number> | null {
  const exif: Record<string, string | number> = {};
  if (rawExif && typeof rawExif === "object") {
    const r = rawExif as Record<string, unknown>;
    for (const key of EXIF_STRING_KEYS) {
      const v = r[key];
      if (typeof v === "string") exif[key] = clampBytes(v, MAX_EXIF_STRING_BYTES);
    }
    const iso = r.iso;
    if (typeof iso === "number" && Number.isFinite(iso) && Number.isInteger(iso) && iso >= 0) {
      exif.iso = iso;
    }
  }
  if (typeof rawLocation === "string" && rawLocation.length > 0) {
    exif.location = clampBytes(rawLocation, MAX_LOCATION_BYTES);
  }
  return Object.keys(exif).length > 0 ? exif : null;
}

function clampTags(rawTags: unknown): string[] {
  if (!Array.isArray(rawTags)) return [];
  const out: string[] = [];
  for (const t of rawTags) {
    if (typeof t !== "string") continue;
    if (out.length >= MAX_TAGS) break;
    out.push(clampBytes(t, MAX_TAG_BYTES));
  }
  return out;
}

export function mapOpencontentPhotograph(ctx: Ctx, record: any): MappedPhoto | null {
  const cid = blobCid(record?.image);
  if (!cid) return null;
  const ar = record?.aspectRatio;
  if (!isPositiveInt(ar?.width) || !isPositiveInt(ar?.height)) return null;
  const capturedAt = parseDate(record.capturedAt);
  const createdAt = parseDate(record.createdAt);
  const exif = buildExif(record.exif, record.location);
  return {
    atUri: atUri(ctx), mediaIndex: 0, did: ctx.did, source: "opencontent",
    recordCid: ctx.cid, blobCid: cid,
    width: ar.width, height: ar.height,
    alt: record.alt ?? null, title: record.title ?? null, caption: record.description ?? null,
    capturedAt, createdAt, sortAt: clampSortAt(createdAt, ctx.indexedAt),
    exif, tags: clampTags(record.tags), license: record.license ?? null,
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
      .slice(0, MAX_COLLECTION_ITEMS) // spec maxLength 500; excess truncated, order preserved
      .map((it: any, i: number) => ({ photoUri: it?.uri, position: i }))
      .filter((it: { photoUri: unknown }) => typeof it.photoUri === "string" && it.photoUri.length > 0) as { photoUri: string; position: number }[],
    itemsAuthoritative: true, // an opencontent collection's items[] IS the membership + order, even when empty
  };
}
