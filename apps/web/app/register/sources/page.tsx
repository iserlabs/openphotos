import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { saveSources } from "../actions";

export const metadata: Metadata = {
  title: "Choose sources — OpenPhotos",
};

export default async function SourcesPage() {
  const session = await getSession();
  if (!session.did) redirect("/register?error=session");

  return (
    <div className="mx-auto w-full max-w-md flex-1 px-6 py-20">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
        Choose your sources
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-zinc-400">
        Pick which of your records OpenPhotos should index for{" "}
        <span className="font-medium text-zinc-200">
          {session.handle ?? session.did}
        </span>
        . Dedicated portfolio records (social.opencontent.photograph) are always included.
      </p>

      <form action={saveSources} className="mt-8 space-y-5">
        <label className="flex items-start gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 px-4 py-3">
          <input
            type="checkbox"
            name="includeBsky"
            defaultChecked
            className="mt-1 h-4 w-4 accent-sky-500"
          />
          <span>
            <span className="block text-sm font-medium text-zinc-100">
              Bluesky image posts
            </span>
            <span className="block text-sm text-zinc-400">
              Index image posts from your app.bsky.feed records.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 px-4 py-3">
          <input
            type="checkbox"
            name="includeGrain"
            defaultChecked
            className="mt-1 h-4 w-4 accent-sky-500"
          />
          <span>
            <span className="block text-sm font-medium text-zinc-100">
              Grain photos
            </span>
            <span className="block text-sm text-zinc-400">
              Index photos you&apos;ve published with Grain.
            </span>
          </span>
        </label>

        <button
          type="submit"
          className="w-full rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
        >
          Start indexing
        </button>
      </form>
    </div>
  );
}
