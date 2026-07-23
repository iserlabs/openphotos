"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { markReadAction } from "@/app/notifications/actions";

/**
 * Marks the given (already-rendered) notification ids read, exactly once,
 * after the component has actually mounted in the browser.
 *
 * Fires after real browser mount only — marking read during server render
 * would let Next's link prefetch mark notifications read that no human ever
 * saw (spec §6).
 *
 * The empty effect dependency array is deliberate, not an oversight: `ids`
 * is a snapshot of THIS page load's unread rows. `router.refresh()` below
 * re-renders this same component in place with fresh (now read, so empty)
 * ids — that prop update must NOT re-trigger the effect, or it would loop.
 * A genuinely new page load (e.g. clicking "Load more") mounts a fresh
 * instance with its own ids, which is exactly when we want it to fire again.
 */
export function MarkReadOnMount({ ids }: { ids: number[] }) {
  const router = useRouter();

  useEffect(() => {
    if (!ids.length) return;
    void markReadAction(ids).then(() => router.refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
