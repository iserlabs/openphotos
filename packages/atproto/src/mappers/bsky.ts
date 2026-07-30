import { atUri, blobCid, selfLabelVals, parseDate, type Ctx, type MappedPhoto, type MappedProfile } from "./types.js";
import { clampSortAt } from "./luminance.js";

export function mapBskyPost(ctx: Ctx, record: any): MappedPhoto[] {
  if (record?.reply) return []; // conversation, not portfolio (spec §7)
  // Two image-carrying embed shapes exist: the classic 4-image
  // app.bsky.embed.images ({images: [...]}) and the newer 10-image
  // app.bsky.embed.gallery ({items: [...]}). Item fields (image/alt/
  // aspectRatio) are identical. Everything else (recordWithMedia, video,
  // external) is skipped in v1.
  const embedType = record?.embed?.$type;
  const images =
    embedType === "app.bsky.embed.images"
      ? record.embed.images
      : embedType === "app.bsky.embed.gallery"
        ? record.embed.items
        : null;
  if (!Array.isArray(images)) return [];
  const uri = atUri(ctx);
  const createdAt = parseDate(record.createdAt);
  const labels = selfLabelVals(record.labels);
  const rows: MappedPhoto[] = [];
  images.forEach((img: any, i: number) => {
    const cid = blobCid(img?.image);
    if (!cid) return;
    rows.push({
      atUri: uri, mediaIndex: i, did: ctx.did, source: "bsky", recordCid: ctx.cid, blobCid: cid,
      width: img.aspectRatio?.width ?? null, height: img.aspectRatio?.height ?? null,
      alt: img.alt || null, title: null, caption: record.text || null,
      capturedAt: null, createdAt, sortAt: clampSortAt(createdAt, ctx.indexedAt),
      exif: null, tags: [], license: null, labels, groupKey: uri,
    });
  });
  return rows;
}

export function mapBskyProfile(did: string, record: any): MappedProfile {
  return {
    did, displayName: record?.displayName ?? null, bio: record?.description ?? null,
    website: null, location: null, avatarCid: blobCid(record?.avatar),
  };
}
