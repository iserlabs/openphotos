import { atUri, blobCid, selfLabelVals, parseDate, type Ctx, type MappedPhoto, type MappedProfile } from "./types.js";
import { clampSortAt } from "./luminance.js";

export function mapBskyPost(ctx: Ctx, record: any): MappedPhoto[] {
  if (record?.reply) return []; // conversation, not portfolio (spec §7)
  if (record?.embed?.$type !== "app.bsky.embed.images") return []; // also excludes recordWithMedia (v1)
  const uri = atUri(ctx);
  const createdAt = parseDate(record.createdAt);
  const labels = selfLabelVals(record.labels);
  const rows: MappedPhoto[] = [];
  (record.embed.images ?? []).forEach((img: any, i: number) => {
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
