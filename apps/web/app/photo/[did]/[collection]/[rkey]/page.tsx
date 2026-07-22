import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { getPhotoRecord, isSensitive, buildAtUri } from "@/lib/queries";
import { safeExternalHref } from "@/lib/safe-href";
import { SensitiveImage } from "@/components/photo-card";
import type { Db } from "@luminance/db";

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

async function load(db: Db, { did, collection, rkey }: Params) {
  const atUri = buildAtUri(decodeParam(did), decodeParam(collection), decodeParam(rkey));
  return getPhotoRecord(db, atUri);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const p = await params;
  const rec = await load(getDb(), p);
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
  const rec = await load(getDb(), p);
  if (!rec) notFound();
  const { items, photographer } = rec;
  const decodedDid = decodeParam(p.did);

  const sourceHref =
    items[0].source === "bsky"
      ? `https://bsky.app/profile/${decodedDid}/post/${p.rkey}`
      : safeExternalHref(photographer.website);

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
                <div
                  style={{ aspectRatio: `${photo.width ?? 3}/${photo.height ?? 2}` }}
                  className="overflow-hidden rounded-md bg-zinc-900"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/img/${encodeURIComponent(photo.did)}/${encodeURIComponent(photo.blobCid)}/full`}
                    alt={photo.alt ?? ""}
                    width={photo.width ?? undefined}
                    height={photo.height ?? undefined}
                    loading={i === 0 ? "eager" : "lazy"}
                    fetchPriority={i === 0 ? "high" : undefined}
                    className="h-full w-full object-contain"
                  />
                </div>
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
    </div>
  );
}
