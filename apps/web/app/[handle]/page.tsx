import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_cache } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { feedPage, engagementFor, findInteraction, photos, photoOverrides, series as seriesTable } from "@luminance/db";
import { AppView } from "@luminance/atproto";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { getSession } from "@/lib/session";
import { getPhotographerByHandle, splitAtUri } from "@/lib/queries";
import { safeExternalHref } from "@/lib/safe-href";
import { PhotoGrid } from "@/components/photo-grid";
import { FollowButton } from "@/components/follow-button";

// Live DB per request — profiles reflect current index/moderation state.
export const dynamic = "force-dynamic";

const PHOTO_PAGE_SIZE = 60;

const appView = new AppView();

/**
 * `AppView.getProfile` goes through `safeJsonFetch` (undici's `fetch`
 * directly, not Next's patched global `fetch`), so Next's `{ next:
 * { revalidate } }` fetch-cache option never applies to it. `unstable_cache`
 * is the documented fallback for caching non-`fetch` async functions in this
 * (pre-Cache-Components — `cacheComponents` isn't enabled in next.config.ts)
 * model: a 5-minute revalidate window, matching the spec's follower-count
 * freshness target without a network round-trip on every profile render.
 */
const getCachedFollowerCount = unstable_cache(
  async (did: string) => (await appView.getProfile(did)).followersCount,
  ["profile-follower-count"],
  { revalidate: 300 },
);

/** Wrapped separately from the cache so a thrown/rejected AppView call never gets cached as a failure — only render nothing this request. */
async function getFollowerCount(did: string): Promise<number | null> {
  try {
    return await getCachedFollowerCount(did);
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const db = getDb();
  const photographer = await getPhotographerByHandle(db, handle);
  if (!photographer) return {};

  const title = photographer.displayName ?? photographer.handle;
  const description = photographer.bio ?? `Photography by ${title} on Luminance.`;
  const { items } = await feedPage(db, { limit: 1, did: photographer.did });
  const first = items[0];
  const images = first
    ? [`${env.PUBLIC_URL}/img/${encodeURIComponent(first.did)}/${encodeURIComponent(first.blobCid)}/feed`]
    : undefined;

  return {
    title: `${title} — Luminance`,
    description,
    openGraph: { title, description, images, type: "profile" },
  };
}

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const db = getDb();
  const photographer = await getPhotographerByHandle(db, handle);
  if (!photographer) notFound();

  const websiteHref = safeExternalHref(photographer.website);
  const session = await getSession();
  const isOwnProfile = session.did === photographer.did;

  // `items` must resolve before we know which atUris to hand to `engagementFor`,
  // but the other three queries below have no dependency on it — kick every
  // promise off up front, await only the blocking one here, then fold
  // `engagementFor` into a single Promise.all with the rest so it runs
  // concurrently with whichever of them is still in flight instead of being
  // awaited sequentially after all four already resolved.
  const itemsPromise = feedPage(db, { limit: PHOTO_PAGE_SIZE, did: photographer.did });
  const seriesRowsPromise = db
    .select({
      atUri: seriesTable.atUri,
      title: seriesTable.title,
      // Suppress the cover thumbnail when it's hidden/taken-down, but keep the
      // series in the shelf (hence CASE rather than a WHERE filter).
      coverBlobCid: sql<string | null>`case when coalesce(${photoOverrides.hidden}, false) = false and coalesce(${photoOverrides.takedown}, false) = false then ${photos.blobCid} end`,
      coverDid: sql<string | null>`case when coalesce(${photoOverrides.hidden}, false) = false and coalesce(${photoOverrides.takedown}, false) = false then ${photos.did} end`,
    })
    .from(seriesTable)
    .leftJoin(photos, and(eq(photos.atUri, seriesTable.coverPhotoUri), eq(photos.mediaIndex, 0)))
    .leftJoin(photoOverrides, and(eq(photoOverrides.atUri, photos.atUri), eq(photoOverrides.mediaIndex, photos.mediaIndex)))
    .where(eq(seriesTable.did, photographer.did));
  const followerCountPromise = getFollowerCount(photographer.did);
  // Write-through truth (spec-honest seam, see FollowButton doc comment):
  // reflects follows made through Luminance, not necessarily the live
  // Bluesky graph. Skipped entirely when signed out — nothing to look up.
  const viewerFollowPromise =
    session.did && !isOwnProfile ? findInteraction(db, session.did, "follow", photographer.did) : Promise.resolve(null);

  const { items } = await itemsPromise;

  // ONE grouped engagementFor call per page render (spec §3 constraint —
  // never per-tile). Only bsky-source posts have real engagement; dedupe
  // atUris since a multi-image post repeats its atUri across mediaIndex rows.
  const bskyUris = [...new Set(items.filter((p) => p.source === "bsky").map((p) => p.atUri))];

  const [seriesRows, followerCount, viewerFollow, counts] = await Promise.all([
    seriesRowsPromise,
    followerCountPromise,
    viewerFollowPromise,
    engagementFor(db, bskyUris),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <header className="flex flex-col items-center gap-4 border-b border-zinc-800 pb-8 text-center sm:flex-row sm:items-start sm:text-left">
        {photographer.avatarCid ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/img/${encodeURIComponent(photographer.did)}/${encodeURIComponent(photographer.avatarCid)}/thumb`}
            alt=""
            width={96}
            height={96}
            loading="lazy"
            className="h-24 w-24 flex-none rounded-full object-cover"
          />
        ) : (
          <div className="h-24 w-24 flex-none rounded-full bg-zinc-800" />
        )}
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            {photographer.displayName ?? photographer.handle}
          </h1>
          <p className="text-sm text-zinc-500">@{photographer.handle}</p>
          {/* Follower count comes from the Bluesky AppView (5-min cache) — rendered only when the fetch succeeds (spec: fail silent, no stale/zero placeholder). */}
          {followerCount !== null ? (
            <p className="mt-1 text-sm text-zinc-500">
              {followerCount} follower{followerCount === 1 ? "" : "s"}
            </p>
          ) : null}
          {photographer.bio ? (
            <p className="mt-3 max-w-xl text-sm text-zinc-300">{photographer.bio}</p>
          ) : null}
          {websiteHref ? (
            <a
              href={websiteHref}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="mt-3 inline-block text-sm font-medium text-sky-400 hover:text-sky-300"
            >
              {photographer.website}
            </a>
          ) : null}
        </div>
        {!isOwnProfile ? (
          <div className="flex-none">
            <FollowButton
              key={photographer.did}
              photographerDid={photographer.did}
              photographerHandle={photographer.handle}
              signedIn={Boolean(session.did)}
              initialFollowing={Boolean(viewerFollow)}
            />
          </div>
        ) : null}
      </header>

      {seriesRows.length > 0 ? (
        <section className="mt-8 border-b border-zinc-800 pb-8">
          <h2 className="text-lg font-medium text-zinc-100">Series</h2>
          <div className="mt-4 flex gap-4 overflow-x-auto pb-1">
            {seriesRows.map((s) => {
              const parts = splitAtUri(s.atUri);
              if (!parts) return null;
              return (
                <Link
                  key={s.atUri}
                  href={`/${photographer.handle}/series/${parts.rkey}`}
                  className="block w-36 flex-none overflow-hidden rounded-md bg-zinc-900"
                >
                  <div className="aspect-square bg-zinc-800">
                    {s.coverBlobCid && s.coverDid ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/img/${encodeURIComponent(s.coverDid)}/${encodeURIComponent(s.coverBlobCid)}/thumb`}
                        alt=""
                        width={144}
                        height={144}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : null}
                  </div>
                  <p className="truncate px-2 py-1.5 text-xs text-zinc-300">{s.title}</p>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="mt-8">
        {items.length === 0 ? (
          <p className="py-16 text-center text-sm text-zinc-500">No photos indexed yet.</p>
        ) : (
          <PhotoGrid items={items} counts={counts} />
        )}
      </section>
    </div>
  );
}
