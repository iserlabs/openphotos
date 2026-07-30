export type PhotoSource = "luminance" | "bsky" | "grain" | "opencontent";
export interface Ctx { did: string; collection: string; rkey: string; cid: string; indexedAt: Date }
export interface MappedPhoto {
  atUri: string; mediaIndex: number; did: string; source: PhotoSource;
  recordCid: string; blobCid: string; width: number | null; height: number | null;
  alt: string | null; title: string | null; caption: string | null;
  capturedAt: Date | null; createdAt: Date | null; sortAt: Date;
  exif: Record<string, string | number> | null; tags: string[]; license: string | null;
  labels: string[]; groupKey: string | null;
}
export interface MappedSeries {
  atUri: string; did: string; title: string; description: string | null;
  coverPhotoUri: string | null; createdAt: Date | null;
  items: { photoUri: string; position: number }[];
  itemsAuthoritative: boolean;
}
export interface MappedProfile {
  did: string; displayName: string | null; bio: string | null;
  website: string | null; location: string | null; avatarCid: string | null;
}
export const atUri = (c: Ctx) => `at://${c.did}/${c.collection}/${c.rkey}`;
export function blobCid(blob: any): string | null {
  if (typeof blob?.ref?.$link === "string" && blob.ref.$link) return blob.ref.$link;
  if (blob?.ref && typeof blob.ref === "object" && typeof blob.ref.toString === "function") {
    const s = blob.ref.toString();
    return s && s !== "[object Object]" ? s : null;
  }
  return null;
}
export function selfLabelVals(labels: any): string[] {
  if (labels?.$type !== "com.atproto.label.defs#selfLabels") return [];
  if (!Array.isArray(labels.values)) return [];
  return labels.values
    .filter((v: any) => v && typeof v.val === "string" && v.val.length > 0)
    .map((v: any) => v.val as string);
}
export function parseDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
