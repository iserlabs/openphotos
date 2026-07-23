import Link from "next/link";
import { feedPage, engagementFor } from "@luminance/db";
import { getDb } from "@/lib/db";
import { PhotoGrid } from "@/components/photo-grid";

// Live DB per request; the feed always reflects current index state.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const db = getDb();
  const { items, cursor: nextCursor } = await feedPage(db, {
    limit: PAGE_SIZE,
    cursor: cursor || undefined,
  });

  if (items.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-6 py-32 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">
          Feed coming soon
        </h1>
        <p className="mt-4 max-w-md text-zinc-400">
          The Luminance feed will surface photography indexed straight from
          photographers&apos; own PDS records across the network.
        </p>
      </div>
    );
  }

  // ONE grouped engagementFor call per page render (spec §3 constraint —
  // never per-tile). Only bsky-source posts have real engagement (the
  // interaction router only ever mints subjects for `source === "bsky"`);
  // dedupe atUris since a multi-image post repeats its atUri across rows.
  const bskyUris = [...new Set(items.filter((p) => p.source === "bsky").map((p) => p.atUri))];
  const counts = await engagementFor(db, bskyUris);

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <PhotoGrid items={items} counts={counts} />
      {nextCursor ? (
        <div className="mt-8 flex justify-center pb-4">
          <Link
            href={`/?cursor=${encodeURIComponent(nextCursor)}`}
            className="rounded-md border border-zinc-800 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-900"
          >
            Load more
          </Link>
        </div>
      ) : null}
    </div>
  );
}
