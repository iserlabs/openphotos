import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { and, count, desc, eq } from "drizzle-orm";
import { photographers, photos, photoOverrides } from "@luminance/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { setPhotoHidden, updateSources, deregister, adminTakedown } from "./actions";

export const metadata: Metadata = {
  title: "Settings — Luminance",
};

// Session + live DB per request; never cached.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await getSession();
  if (!session.did) redirect("/register?error=session");
  const did = session.did;

  const db = getDb();
  const [me] = await db
    .select({
      handle: photographers.handle,
      includeBsky: photographers.includeBsky,
      includeGrain: photographers.includeGrain,
      status: photographers.status,
    })
    .from(photographers)
    .where(eq(photographers.did, did));
  if (!me) redirect("/register");

  const sp = await searchParams;
  const [{ n: total }] = await db
    .select({ n: count() })
    .from(photos)
    .where(eq(photos.did, did));
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, Number(sp.page) || 1));

  const rows = await db
    .select({
      atUri: photos.atUri,
      mediaIndex: photos.mediaIndex,
      blobCid: photos.blobCid,
      alt: photos.alt,
      title: photos.title,
      hidden: photoOverrides.hidden,
      takedown: photoOverrides.takedown,
    })
    .from(photos)
    .leftJoin(
      photoOverrides,
      and(eq(photoOverrides.atUri, photos.atUri), eq(photoOverrides.mediaIndex, photos.mediaIndex)),
    )
    .where(eq(photos.did, did))
    .orderBy(desc(photos.sortAt), desc(photos.atUri), desc(photos.mediaIndex))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Settings</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Signed in as <span className="text-zinc-200">{me.handle}</span>
          {session.isAdmin ? (
            <span className="ml-2 rounded bg-amber-900/40 px-1.5 py-0.5 text-xs text-amber-300">
              admin
            </span>
          ) : null}
        </p>
      </header>

      {/* Sources */}
      <section className="mt-10">
        <h2 className="text-lg font-medium text-zinc-100">Indexed sources</h2>
        <form action={updateSources} className="mt-4 space-y-3">
          <label className="flex items-center gap-3 text-sm text-zinc-300">
            <input
              type="checkbox"
              name="includeBsky"
              defaultChecked={me.includeBsky}
              className="h-4 w-4 accent-sky-500"
            />
            Bluesky image posts
          </label>
          <label className="flex items-center gap-3 text-sm text-zinc-300">
            <input
              type="checkbox"
              name="includeGrain"
              defaultChecked={me.includeGrain}
              className="h-4 w-4 accent-sky-500"
            />
            Grain photos
          </label>
          <button
            type="submit"
            className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
          >
            Save sources
          </button>
          <p className="text-xs text-zinc-500">
            Saving re-indexes your account so the change takes effect.
          </p>
        </form>
      </section>

      {/* Photo curation */}
      <section className="mt-12">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium text-zinc-100">Your photos</h2>
          <span className="text-xs text-zinc-500">{total} indexed</span>
        </div>

        {rows.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">
            Nothing indexed yet. If you just registered, indexing may still be running.
          </p>
        ) : (
          <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {rows.map((r) => {
              const hidden = Boolean(r.hidden) || Boolean(r.takedown);
              return (
                <li
                  key={`${r.atUri}#${r.mediaIndex}`}
                  className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-900/40"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/img/${encodeURIComponent(did)}/${encodeURIComponent(r.blobCid)}/thumb`}
                    alt={r.alt ?? r.title ?? ""}
                    loading="lazy"
                    className={`aspect-square w-full object-cover ${hidden ? "opacity-30" : ""}`}
                  />
                  <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <span className="truncate text-xs text-zinc-500">
                      {r.takedown ? "taken down" : hidden ? "hidden" : "visible"}
                    </span>
                    {r.takedown ? null : (
                      <form action={setPhotoHidden}>
                        <input type="hidden" name="atUri" value={r.atUri} />
                        <input type="hidden" name="mediaIndex" value={r.mediaIndex} />
                        <input type="hidden" name="hidden" value={hidden ? "false" : "true"} />
                        <button
                          type="submit"
                          className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
                        >
                          {hidden ? "Unhide" : "Hide"}
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {pageCount > 1 ? (
          <nav className="mt-6 flex items-center justify-between text-sm">
            {page > 1 ? (
              <a href={`/settings?page=${page - 1}`} className="text-sky-400 hover:text-sky-300">
                ← Newer
              </a>
            ) : (
              <span />
            )}
            <span className="text-zinc-500">
              Page {page} of {pageCount}
            </span>
            {page < pageCount ? (
              <a href={`/settings?page=${page + 1}`} className="text-sky-400 hover:text-sky-300">
                Older →
              </a>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </section>

      {/* Admin takedown */}
      {session.isAdmin ? (
        <section className="mt-12">
          <h2 className="text-lg font-medium text-amber-300">Admin — takedown</h2>
          <p className="mt-2 text-sm text-zinc-400">
            Suppress any photo network-wide by its AT URI. This is durable and
            survives re-indexing.
          </p>
          <form action={adminTakedown} className="mt-4 space-y-3">
            <input
              name="atUri"
              type="text"
              required
              placeholder="at://did:plc:…/app.luminance.photo/…"
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
            />
            <input
              name="mediaIndex"
              type="number"
              min={0}
              defaultValue={0}
              required
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
            />
            <input
              name="reason"
              type="text"
              placeholder="Reason (optional)"
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-500"
            >
              Take down
            </button>
          </form>
        </section>
      ) : null}

      {/* Danger zone */}
      <section className="mt-12 border-t border-zinc-800 pt-8">
        <h2 className="text-lg font-medium text-red-300">Deregister</h2>
        <p className="mt-2 text-sm text-zinc-400">
          Removes your photos from the Luminance index. Your records stay on your
          PDS, untouched — you can register again any time.
        </p>
        <form action={deregister} className="mt-4 space-y-3">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" name="confirm" required className="h-4 w-4 accent-red-500" />
            I understand this removes me from the index.
          </label>
          <button
            type="submit"
            className="rounded-md border border-red-800 bg-red-950/40 px-3 py-1.5 text-sm font-medium text-red-300 transition-colors hover:bg-red-950/70"
          >
            Deregister me
          </button>
        </form>
      </section>
    </div>
  );
}
