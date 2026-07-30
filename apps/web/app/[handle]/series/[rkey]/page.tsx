import Link from "next/link";
import { notFound } from "next/navigation";
import { OPENCONTENT_COLLECTION } from "@openphotos/lexicons";
import { GRAIN_GALLERY } from "@openphotos/atproto";
import { getDb } from "@/lib/db";
import { getPhotographerByHandle, getSeries, buildAtUri } from "@/lib/queries";
import { PhotoGrid } from "@/components/photo-grid";
import type { Db } from "@openphotos/db";

// Live DB per request.
export const dynamic = "force-dynamic";

// A series lives under one of two possible collections depending on which
// lexicon it was authored with; try an opencontent collection first, then
// fall back to a Grain gallery. (social.luminance.portfolio.series was
// retired 2026-07-28 — zero records ever existed in the wild.)
async function resolveSeries(db: Db, did: string, rkey: string) {
  for (const collection of [OPENCONTENT_COLLECTION, GRAIN_GALLERY]) {
    const found = await getSeries(db, buildAtUri(did, collection, rkey));
    if (found) return found;
  }
  return null;
}

export default async function SeriesPage({
  params,
}: {
  params: Promise<{ handle: string; rkey: string }>;
}) {
  const { handle, rkey } = await params;
  const db = getDb();
  const photographer = await getPhotographerByHandle(db, handle);
  if (!photographer) notFound();

  const found = await resolveSeries(db, photographer.did, rkey);
  if (!found) notFound();
  const { series, items } = found;

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <header className="border-b border-zinc-800 pb-6">
        <Link href={`/${photographer.handle}`} className="text-sm text-zinc-500 hover:text-zinc-300">
          {photographer.displayName ?? photographer.handle}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-100">{series.title}</h1>
        {series.description ? (
          <p className="mt-2 max-w-2xl text-sm text-zinc-400">{series.description}</p>
        ) : null}
      </header>

      <div className="mt-8">
        {items.length === 0 ? (
          <p className="py-16 text-center text-sm text-zinc-500">No photos in this series yet.</p>
        ) : (
          <PhotoGrid items={items} />
        )}
      </div>
    </div>
  );
}
