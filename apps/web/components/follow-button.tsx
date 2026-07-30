"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { followAction, unfollowAction } from "@/app/[handle]/actions";
import { SESSION_EXPIRED_ERROR, loginHref } from "@/lib/interaction-errors";

/**
 * Profile-page follow/unfollow control. Three states:
 *
 * - Signed out: a plain link to `/login?returnTo=/<handle>` — no client
 *   state at all, so no flash of a button that can't actually do anything.
 * - Signed in, not following: "Follow" -> `followAction`.
 * - Signed in, following: "Following" -> `unfollowAction`.
 *
 * `photographerDid`/`photographerHandle` travel as hidden form fields (the
 * profile page the viewer is currently on); the actor's own identity is
 * NEVER read from this component's props — `followAction`/`unfollowAction`
 * pull it from the session server-side (see app/[handle]/actions.ts).
 *
 * `initialFollowing` is write-through truth from `findInteraction`, not live
 * Bluesky state — same honest seam as the like button: a follow made
 * directly in the Bluesky app will show up in the profile's follower count
 * (AppView-sourced) before this button reflects it. Only a follow/unfollow
 * made through OpenPhotos itself updates this component's state, and
 * `router.refresh()` re-derives `initialFollowing` from the DB afterward.
 */
export function FollowButton({
  photographerDid,
  photographerHandle,
  signedIn,
  initialFollowing,
}: {
  photographerDid: string;
  photographerHandle: string;
  signedIn: boolean;
  initialFollowing: boolean;
}) {
  const router = useRouter();
  const [following, setFollowing] = useState(initialFollowing);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!signedIn) {
    return (
      <Link
        href={`/login?returnTo=/${photographerHandle}`}
        className="inline-block rounded-md border border-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-900"
      >
        Follow
      </Link>
    );
  }

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = following ? await unfollowAction(formData) : await followAction(formData);
      if (result.ok) {
        setFollowing((f) => !f);
        router.refresh();
      } else if (result.error === SESSION_EXPIRED_ERROR) {
        router.push(loginHref(`/${photographerHandle}`));
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="inline-flex flex-col items-start gap-1.5">
      <form action={handleSubmit}>
        <input type="hidden" name="photographerDid" value={photographerDid} />
        <input type="hidden" name="photographerHandle" value={photographerHandle} />
        <button
          type="submit"
          disabled={isPending}
          className={
            following
              ? "rounded-md border border-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:border-red-900/60 hover:text-red-300 disabled:opacity-50"
              : "rounded-md bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
          }
        >
          {following ? "Following" : "Follow"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
