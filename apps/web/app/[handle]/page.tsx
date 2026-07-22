import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { feedPage, photos, photoOverrides, series as seriesTable } from "@luminance/db";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { getPhotographerByHandle, splitAtUri } from "@/lib/queries";
import { safeExternalHref } from "@/lib/safe-href";
import { PhotoGrid } from "@/components/photo-grid";

// Live DB per request — profiles reflect current index/moderation state.
export const dynamic = "force-dynamic";

const PHOTO_PAGE_SIZE = 60;

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

  const [{ items }, seriesRows] = await Promise.all([
    feedPage(db, { limit: PHOTO_PAGE_SIZE, did: photographer.did }),
    db
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
      .where(eq(seriesTable.did, photographer.did)),
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
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            {photographer.displayName ?? photographer.handle}
          </h1>
          <p className="text-sm text-zinc-500">@{photographer.handle}</p>
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
          <PhotoGrid items={items} />
        )}
      </section>
    </div>
  );
}
