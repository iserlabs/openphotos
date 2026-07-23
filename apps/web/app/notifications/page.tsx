import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { photographers, notificationsPage } from "@luminance/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { splitAtUri } from "@/lib/queries";
import { relativeTime } from "@/lib/relative-time";
import { MarkReadOnMount } from "@/components/mark-read-on-mount";

export const metadata: Metadata = {
  title: "Notifications — Luminance",
};

// Session + live DB per request — unread state must never be cached.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type NotificationRow = {
  id: number;
  actorHandle: string;
  actorAvatarUrl: string | null;
  kind: "like" | "comment" | "follow";
  linkUri: string;
  snippet: string | null;
  createdAt: Date;
  readAt: Date | null;
};

/** "liked your photo" / "commented: <snippet>" / "followed you" (spec §6). */
function verb(n: Pick<NotificationRow, "kind" | "snippet">): string {
  switch (n.kind) {
    case "like":
      return "liked your photo";
    case "comment":
      return `commented: ${n.snippet ?? ""}`;
    case "follow":
      return "followed you";
  }
}

/**
 * A follow's `linkUri` is already a site-relative path (`/handle` — see the
 * engagement sweep). A like/comment's `linkUri` is the underlying photo's
 * at-uri, which needs splitting into the photo-detail route, `did`
 * percent-encoded the same way `PhotoGrid` encodes it.
 */
function notificationHref(n: Pick<NotificationRow, "kind" | "linkUri">): string | null {
  if (n.kind === "follow") return n.linkUri;
  const parts = splitAtUri(n.linkUri);
  if (!parts) return null;
  return `/photo/${encodeURIComponent(parts.did)}/${parts.collection}/${parts.rkey}`;
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const session = await getSession();
  if (!session.did) redirect("/login?returnTo=/notifications");

  const db = getDb();
  const [me] = await db.select({ did: photographers.did }).from(photographers).where(eq(photographers.did, session.did));
  if (!me) redirect("/login?returnTo=/notifications");

  const { cursor: cursorParam } = await searchParams;
  const rawCursor = cursorParam ? Number(cursorParam) : undefined;
  const cursor = rawCursor !== undefined && Number.isFinite(rawCursor) ? rawCursor : undefined;

  const { items, cursor: nextCursor } = await notificationsPage(db, session.did, {
    limit: PAGE_SIZE,
    cursor,
  });
  const unreadIds = items.filter((n) => n.readAt == null).map((n) => n.id);

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
      <MarkReadOnMount ids={unreadIds} />

      <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Notifications</h1>

      {items.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">No notifications yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-zinc-800">
          {items.map((n) => {
            const href = notificationHref(n);
            const row = (
              <div className={`flex items-center gap-3 rounded-md px-2 py-4 ${n.readAt == null ? "bg-zinc-900/40" : ""}`}>
                {n.actorAvatarUrl ? (
                  // Bluesky CDN avatar URL, rendered directly — the documented
                  // proxy exception (spec §11 only allowlists blobs OUR index
                  // references; other actors' avatars are never ours to proxy).
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={n.actorAvatarUrl}
                    alt=""
                    width={40}
                    height={40}
                    loading="lazy"
                    className="h-10 w-10 flex-none rounded-full object-cover"
                  />
                ) : (
                  <div className="h-10 w-10 flex-none rounded-full bg-zinc-800" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-zinc-200">
                    <span className="font-medium text-zinc-100">{n.actorHandle}</span> {verb(n)}
                  </p>
                </div>
                <span className="flex-none text-xs text-zinc-500">{relativeTime(n.createdAt)}</span>
              </div>
            );
            return (
              <li key={n.id}>
                {href ? (
                  <Link href={href} className="-mx-2 block transition-colors hover:bg-zinc-900/60 rounded-md">
                    {row}
                  </Link>
                ) : (
                  row
                )}
              </li>
            );
          })}
        </ul>
      )}

      {nextCursor ? (
        <div className="mt-8 flex justify-center pb-4">
          <Link
            href={`/notifications?cursor=${encodeURIComponent(nextCursor)}`}
            className="rounded-md border border-zinc-800 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-900"
          >
            Load more
          </Link>
        </div>
      ) : null}
    </div>
  );
}
