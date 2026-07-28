import { blobCid, type MappedProfile } from "./types.js";

// social.luminance.portfolio.{photo,series} were retired 2026-07-28 (zero
// records ever existed in the wild — see docs/runbooks/publish-lexicons.md §7);
// their mapLuminancePhoto/mapLuminanceSeries mappers were deleted along with
// them. clampSortAt is a shared helper (still used by the bsky/grain/opencontent
// mappers) and mapLuminanceProfile backs the still-active `social.luminance.actor.profile`
// (LUMINANCE_PROFILE) — both survive here.

const CLAMP_MS = 10 * 60 * 1000; // spec §8: 10 minutes
export function clampSortAt(claimed: Date | null, indexedAt: Date): Date {
  if (!claimed) return indexedAt;
  const max = indexedAt.getTime() + CLAMP_MS;
  return claimed.getTime() > max ? new Date(max) : claimed;
}

export function mapLuminanceProfile(did: string, record: any): MappedProfile {
  return {
    did, displayName: record?.displayName ?? null, bio: record?.bio ?? null,
    website: record?.websiteUrl ?? null, location: record?.location ?? null,
    avatarCid: blobCid(record?.avatar),
  };
}
