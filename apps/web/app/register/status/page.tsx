import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { photographers } from "@luminance/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Indexing status — Luminance",
};

// Reads the session + live DB per request; never cached.
export const dynamic = "force-dynamic";

const LABELS: Record<string, string> = {
  pending: "Queued — waiting for the indexer to pick up your account…",
  running: "Indexing your photos from your PDS…",
  complete: "Your photos are live.",
  failed: "Something went wrong while indexing. Please try registering again.",
};

export default async function StatusPage() {
  const session = await getSession();
  if (!session.did) redirect("/register?error=session");

  const db = getDb();
  const [row] = await db
    .select({ handle: photographers.handle, backfillStatus: photographers.backfillStatus })
    .from(photographers)
    .where(eq(photographers.did, session.did));

  if (!row) redirect("/register/sources");

  const status = row.backfillStatus;
  const done = status === "complete";
  const failed = status === "failed";

  return (
    <div className="mx-auto w-full max-w-md flex-1 px-6 py-20">
      {/* React 19 hoists this to <head>; poll every 3s until backfill finishes. */}
      {!done && !failed ? <meta httpEquiv="refresh" content="3" /> : null}

      <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
        {done ? "You're indexed" : "Setting things up"}
      </h1>

      <div className="mt-6 flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 px-4 py-3">
        {!done && !failed ? (
          <span
            aria-hidden
            className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-sky-400"
          />
        ) : null}
        <p className={`text-sm ${failed ? "text-red-300" : "text-zinc-300"}`}>
          {LABELS[status] ?? status}
        </p>
      </div>

      {done ? (
        <a
          href={`/${row.handle}`}
          className="mt-8 inline-block rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
        >
          View your profile
        </a>
      ) : failed ? (
        <a href="/register" className="mt-8 inline-block text-sm text-sky-400 hover:text-sky-300">
          Back to registration
        </a>
      ) : (
        <p className="mt-6 text-sm text-zinc-500">
          This page refreshes automatically. You can safely leave and come back.
        </p>
      )}
    </div>
  );
}
