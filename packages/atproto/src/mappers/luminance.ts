import { atUri, blobCid, selfLabelVals, parseDate, type Ctx, type MappedPhoto, type MappedSeries, type MappedProfile } from "./types.js";

const CLAMP_MS = 10 * 60 * 1000; // spec §8: 10 minutes
export function clampSortAt(claimed: Date | null, indexedAt: Date): Date {
  if (!claimed) return indexedAt;
  const max = indexedAt.getTime() + CLAMP_MS;
  return claimed.getTime() > max ? new Date(max) : claimed;
}

export function mapLuminancePhoto(ctx: Ctx, record: any): MappedPhoto | null {
  const cid = blobCid(record?.image);
  if (!cid) return null;
  const capturedAt = parseDate(record.capturedAt);
  const createdAt = parseDate(record.createdAt);
  return {
    atUri: atUri(ctx), mediaIndex: 0, did: ctx.did, source: "luminance",
    recordCid: ctx.cid, blobCid: cid,
    width: record.aspectRatio?.width ?? null, height: record.aspectRatio?.height ?? null,
    alt: record.alt ?? null, title: record.title ?? null, caption: record.caption ?? null,
    capturedAt, createdAt, sortAt: clampSortAt(capturedAt ?? createdAt, ctx.indexedAt),
    exif: record.exif ?? null, tags: record.tags ?? [], license: record.license ?? null,
    labels: selfLabelVals(record.labels), groupKey: null,
  };
}

export function mapLuminanceSeries(ctx: Ctx, record: any): MappedSeries | null {
  if (!record?.title || !Array.isArray(record?.photos)) return null;
  return {
    atUri: atUri(ctx), did: ctx.did, title: record.title, description: record.description ?? null,
    coverPhotoUri: record.coverPhoto?.uri ?? null, createdAt: parseDate(record.createdAt),
    items: record.photos.map((p: any, i: number) => ({ photoUri: p.uri, position: i })).filter((p: any) => p.photoUri),
  };
}

export function mapLuminanceProfile(did: string, record: any): MappedProfile {
  return {
    did, displayName: record?.displayName ?? null, bio: record?.bio ?? null,
    website: record?.websiteUrl ?? null, location: record?.location ?? null,
    avatarCid: blobCid(record?.avatar),
  };
}
