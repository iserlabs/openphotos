import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_cache } from "next/cache";
import { AppView, type ThreadView } from "@luminance/atproto";
import { engagementFor, findInteraction } from "@luminance/db";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { getSession } from "@/lib/session";
import { routeInteraction } from "@/lib/interactions";
import { getPhotoRecord, isSensitive, buildAtUri } from "@/lib/queries";
import { safeExternalHref } from "@/lib/safe-href";
import { flattenThread, pendingOwnComments } from "@/lib/thread";
import { SensitiveImage } from "@/components/photo-card";
import { LikeButton } from "@/components/like-button";
import { CommentThread } from "@/components/comment-thread";
import { CommentComposer } from "@/components/comment-composer";
import { LightboxProvider, LightboxTrigger } from "@/components/lightbox";

// Live DB per request — moderation/label state must always be current.
export const dynamic = "force-dynamic";

type Params = { did: string; collection: string; rkey: string };

const EXIF_FIELDS: { key: "camera" | "lens" | "focalLength" | "fNumber" | "shutterSpeed" | "iso"; label: string }[] = [
  { key: "camera", label: "Camera" },
  { key: "lens", label: "Lens" },
  { key: "focalLength", label: "Focal length" },
  { key: "fNumber", label: "Aperture" },
  { key: "shutterSpeed", label: "Shutter speed" },
  { key: "iso", label: "ISO" },
];

// Next 16 delivers PAGE params percent-encoded (`did%3Aplc%3A…`) even when the
// URL holds a literal `:` — verified empirically; route handlers (e.g. /img)
// get them decoded. Decode exactly once, tolerating malformed input.
function decodeParam(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 60s cache for the read-only Bluesky thread (spec §7). `unstable_cache` is
 * independent of this route's `force-dynamic` segment config: that setting
 * only forces per-request *rendering* and disables `fetch()` caching — it
 * does not touch Next's Data Cache, which `unstable_cache` uses here to
 * persist this non-`fetch` AppView call across requests. Keyed on the at-uri
 * (its only argument) so different photos never share an entry. Chosen over
 * a bare per-request call because the brief calls for an explicit 60s cache
 * and this is the simplest mechanism that coexists with force-dynamic; a
 * plain uncached call remains the documented fallback if this ever proves to
 * fight the route's dynamic rendering in practice.
 *
 * The static `"photo-threads"` tag lets the comment/delete server actions
 * `revalidateTag` this cache after a write, so a just-posted (or just-deleted)
 * comment shows on the next render instead of waiting out the 60s TTL.
 */
const getCachedThread = unstable_cache(
  async (atUri: string): Promise<ThreadView> => new AppView().getPostThread(atUri, 10),
  ["photo-thread"],
  { revalidate: 60, tags: ["photo-threads"] },
);

// React.cache: generateMetadata and the page body both need this record, and
// Next runs them as separate calls in the same request — per-request memoized
// on the at-uri (a primitive key; the params OBJECTS differ between the two
// calls, so keying on them would never hit).
const cachedGetPhotoRecord = cache((atUri: string) => getPhotoRecord(getDb(), atUri));

async function load({ did, collection, rkey }: Params) {
  const atUri = buildAtUri(decodeParam(did), decodeParam(collection), decodeParam(rkey));
  return cachedGetPhotoRecord(atUri);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const p = await params;
  const rec = await load(p);
  if (!rec) return {};

  const first = rec.items[0];
  const title = first.title || `Photo by ${rec.photographer.displayName ?? rec.photographer.handle}`;
  const description = first.alt || first.caption || undefined;

  return {
    title: `${title} — Luminance`,
    description,
    openGraph: {
      title,
      description,
      images: [`${env.PUBLIC_URL}/img/${encodeURIComponent(first.did)}/${encodeURIComponent(first.blobCid)}/feed`],
    },
  };
}

export default async function PhotoDetailPage({ params }: { params: Promise<Params> }) {
  const p = await params;
  const rec = await load(p);
  if (!rec) notFound();
  const { items, photographer } = rec;
  const decodedDid = decodeParam(p.did);
  const decodedCollection = decodeParam(p.collection);
  const decodedRkey = decodeParam(p.rkey);
  const atUri = buildAtUri(decodedDid, decodedCollection, decodedRkey);
  const returnTo = `/photo/${encodeURIComponent(decodedDid)}/${decodedCollection}/${decodedRkey}`;

  const sourceHref =
    items[0].source === "bsky"
      ? `https://bsky.app/profile/${decodedDid}/post/${p.rkey}`
      : safeExternalHref(photographer.website);

  // Interactions (likes/comments) only exist for bsky-sourced photos — a real
  // app.bsky.feed.post backs them. Luminance/grain sources get a disabled row
  // instead (spec §7/§10 — phase 3 fills this router branch).
  const routed = routeInteraction(items[0]);
  const session = await getSession();

  let likeCount = 0;
  let liked = false;
  let commentNodes: ReturnType<typeof flattenThread> = [];
  let threadUnavailable = false;

  if (routed.supported) {
    const db = getDb();
    const [engagement, interaction] = await Promise.all([
      engagementFor(db, [atUri]),
      session.did ? findInteraction(db, session.did, "like", atUri) : Promise.resolve(null),
    ]);
    likeCount = engagement.get(atUri)?.likeCount ?? 0;
    liked = interaction != null;

    try {
      const thread = await getCachedThread(atUri);
      commentNodes = flattenThread(thread, { maxDepth: 2 });
      // Merge the viewer's own comments the cached AppView thread hasn't indexed
      // yet (write-through row exists, AppView lag ~1min) so the author always
      // sees their just-posted comment immediately.
      if (session.did) {
        const existing = new Set(commentNodes.map((n) => n.uri));
        const pending = await pendingOwnComments(db, session.did, session.handle ?? session.did, atUri, existing);
        commentNodes = [...commentNodes, ...pending];
      }
    } catch {
      threadUnavailable = true;
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <Link href={`/${photographer.handle}`} className="text-sm text-zinc-400 hover:text-zinc-200">
          {photographer.displayName ?? photographer.handle}
        </Link>
        {sourceHref ? (
          <a
            href={sourceHref}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-sm text-sky-400 hover:text-sky-300"
          >
            {items[0].source === "bsky" ? "View on Bluesky" : "Photographer's site"}
          </a>
        ) : null}
      </header>

      <LightboxProvider
        items={items.map((photo) => ({
          src: `/img/${encodeURIComponent(photo.did)}/${encodeURIComponent(photo.blobCid)}/full`,
          alt: photo.alt ?? "",
        }))}
      >
      <div className="mt-8 space-y-12">
        {items.map((photo, i) => {
          // Practically at most one item ever carries a title (only bsky
          // posts have >1 mediaIndex row, and bsky never sets title), but
          // keep the page to a single <h1> regardless.
          const Heading = i === 0 ? "h1" : "h2";
          const exifEntries = photo.exif
            ? EXIF_FIELDS.filter(({ key }) => {
                const v = (photo.exif as Record<string, string | number | undefined>)[key];
                return v !== undefined && v !== null && v !== "";
              })
            : [];

          return (
            <figure key={photo.mediaIndex} id={`i${photo.mediaIndex}`} className="scroll-mt-6">
              <SensitiveImage sensitive={isSensitive(photo.labels)}>
                <LightboxTrigger index={i}>
                <div
                  style={{
                    aspectRatio: `${photo.width ?? 3}/${photo.height ?? 2}`,
                    // Blur-up placeholder behind the full rendition (the box's
                    // aspect matches the photo, so cover ≈ contain here).
                    ...(photo.blurDataUrl
                      ? { backgroundImage: `url("${photo.blurDataUrl}")`, backgroundSize: "cover" }
                      : {}),
                  }}
                  className="overflow-hidden rounded-md bg-zinc-900"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/img/${encodeURIComponent(photo.did)}/${encodeURIComponent(photo.blobCid)}/full`}
                    srcSet={`/img/${encodeURIComponent(photo.did)}/${encodeURIComponent(photo.blobCid)}/feed 1024w, /img/${encodeURIComponent(photo.did)}/${encodeURIComponent(photo.blobCid)}/full 2048w`}
                    sizes="(min-width: 768px) 720px, 100vw"
                    alt={photo.alt ?? ""}
                    width={photo.width ?? undefined}
                    height={photo.height ?? undefined}
                    loading={i === 0 ? "eager" : "lazy"}
                    fetchPriority={i === 0 ? "high" : undefined}
                    className="h-full w-full object-contain"
                  />
                </div>
                </LightboxTrigger>
              </SensitiveImage>

              {photo.title ? (
                <Heading className="mt-4 text-xl font-semibold tracking-tight text-zinc-100">
                  {photo.title}
                </Heading>
              ) : null}
              {photo.caption ? <p className="mt-2 text-sm text-zinc-300">{photo.caption}</p> : null}

              {exifEntries.length > 0 ? (
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                  {exifEntries.map(({ key, label }) => (
                    <div key={key}>
                      <dt className="text-zinc-600">{label}</dt>
                      <dd className="text-zinc-300">
                        {(photo.exif as Record<string, string | number>)[key]}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {photo.tags.length > 0 ? (
                <ul className="mt-4 flex flex-wrap gap-2">
                  {photo.tags.map((tag) => (
                    <li
                      key={tag}
                      className="rounded-full border border-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400"
                    >
                      {tag}
                    </li>
                  ))}
                </ul>
              ) : null}

              {photo.license ? (
                <p className="mt-4 text-xs text-zinc-500">License: {photo.license}</p>
              ) : null}
            </figure>
          );
        })}
      </div>
      </LightboxProvider>

      <section className="mt-12 border-t border-zinc-800 pt-8">
        {routed.supported ? (
          <>
            <LikeButton
              atUri={atUri}
              liked={liked}
              count={likeCount}
              signedIn={session.did != null}
              returnTo={returnTo}
            />

            <div className="mt-8">
              <h2 className="text-sm font-medium text-zinc-400">Comments</h2>

              <div className="mt-3">
                {threadUnavailable ? (
                  <p className="text-sm text-zinc-500">Comments temporarily unavailable</p>
                ) : (
                  <CommentThread nodes={commentNodes} viewerDid={session.did} atUri={atUri} />
                )}
              </div>

              {session.did ? (
                <CommentComposer atUri={atUri} />
              ) : (
                <p className="mt-4 text-sm text-zinc-500">
                  <Link
                    href={`/login?returnTo=${encodeURIComponent(returnTo)}`}
                    className="text-sky-400 hover:text-sky-300"
                  >
                    Sign in
                  </Link>{" "}
                  to comment.
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-zinc-600">Interactions arrive with portfolio publishing</p>
        )}
      </section>
    </div>
  );
}
