"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { likeAction, unlikeAction } from "@/app/photo/actions";
import { SESSION_EXPIRED_ERROR, loginHref } from "@/lib/interaction-errors";

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.75}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z"
      />
    </svg>
  );
}

/**
 * Photo-page like button. Filled heart + count for everyone; interactive
 * (toggleable) only when `signedIn`. Signed-out visitors instead see a
 * disabled heart plus a "Sign in to like" link carrying `returnTo` back to
 * this page (spec §7/§8).
 *
 * Optimistic UI: toggling flips the local display immediately, then confirms
 * via the server action inside a transition. No client-side cache is kept —
 * `router.refresh()` re-fetches the server-rendered truth, and the local
 * optimistic override is dropped (via the effect below) the moment fresh
 * `liked`/`count` props actually arrive, so a failed write cleanly reverts
 * and a successful one settles on the server's own numbers.
 */
export function LikeButton({
  atUri,
  liked,
  count,
  signedIn,
  returnTo,
}: {
  atUri: string;
  liked: boolean;
  count: number;
  signedIn: boolean;
  returnTo: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<{ liked: boolean; count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fresh server props landed (e.g. after router.refresh()) — the optimistic
  // override has served its purpose, whether it matched or not.
  useEffect(() => {
    setOptimistic(null);
  }, [liked, count]);

  const displayLiked = optimistic?.liked ?? liked;
  const displayCount = optimistic?.count ?? count;

  if (!signedIn) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-400">
        <span className="flex items-center gap-1.5 opacity-50">
          <HeartIcon filled={false} />
          {displayCount}
        </span>
        <Link
          href={`/login?returnTo=${encodeURIComponent(returnTo)}`}
          className="text-sky-400 hover:text-sky-300"
        >
          Sign in to like
        </Link>
      </div>
    );
  }

  function toggle() {
    setError(null);
    const next = !displayLiked;
    setOptimistic({ liked: next, count: displayCount + (next ? 1 : -1) });

    const formData = new FormData();
    formData.set("atUri", atUri);

    startTransition(async () => {
      const result = next ? await likeAction(formData) : await unlikeAction(formData);
      if (!result.ok) {
        setOptimistic(null);
        if (result.error === SESSION_EXPIRED_ERROR) {
          router.push(loginHref(returnTo));
          return;
        }
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        disabled={isPending}
        aria-pressed={displayLiked}
        aria-label={displayLiked ? "Unlike" : "Like"}
        className="flex items-center gap-1.5 text-sm text-zinc-300 transition-colors hover:text-zinc-100 disabled:opacity-60"
      >
        <span className={displayLiked ? "text-red-500" : ""}>
          <HeartIcon filled={displayLiked} />
        </span>
        {displayCount}
      </button>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
