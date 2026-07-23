import { deleteCommentAction } from "@/app/photo/actions";
import { relativeTime } from "@/lib/relative-time";
import { safeExternalHref } from "@/lib/safe-href";
import { isSensitive, splitAtUri } from "@/lib/queries";
import { SensitiveText } from "./sensitive-text";
import type { CommentNode } from "@/lib/thread";

const INDENT_PX = 20;

/** `at://did/collection/rkey` -> the reply's own Bluesky permalink, for the
 * per-node "continue this thread on Bluesky" link. `null` for a malformed uri
 * (defensive only — every node here came from a real AppView thread). */
function bskyPermalink(atUri: string): string | null {
  const parts = splitAtUri(atUri);
  return parts ? `https://bsky.app/profile/${parts.did}/post/${parts.rkey}` : null;
}

/**
 * Thin `<form action>` wrapper around `deleteCommentAction`: React's form
 * `action` prop requires a `void`-returning Server Function, but
 * `deleteCommentAction` returns `{ok, error}` (for the client-driven callers
 * in `like-button.tsx`/`comment-composer.tsx`, which display the error).
 * This plain form has nowhere to show an error, so it discards the result —
 * a delete failure just leaves the comment in place, which is self-evident
 * to the viewer. Inlined as a Server Function (`"use server"`) rather than a
 * new exported action, since it's only ever this one call site.
 */
async function deleteComment(formData: FormData): Promise<void> {
  "use server";
  await deleteCommentAction(formData);
}

/**
 * Server-rendered comment thread (spec §7). Renders the flattened,
 * depth-limited `CommentNode[]` from `lib/thread.ts` — moderation (blocked/
 * hidden stubs) is already resolved away by `flattenThread`, so every node
 * here is real and visible-on-Bluesky.
 *
 * - Avatars are actor avatars from Bluesky's CDN (spec §5 exception), but the
 *   URL is still scheme-checked via `safeExternalHref` before use — an
 *   AppView response is untrusted input, and a placeholder is cheap.
 * - Labeled replies (moderation/self labels) render behind the same
 *   blur-gate photos use, via `SensitiveText`.
 * - Delete is offered only on the viewer's own comments.
 * - A node whose deeper replies were clipped by `maxDepth` links out to its
 *   own permalink on Bluesky to continue the thread there.
 */
export function CommentThread({
  nodes,
  viewerDid,
}: {
  nodes: CommentNode[];
  viewerDid?: string;
}) {
  if (nodes.length === 0) {
    return <p className="text-sm text-zinc-500">No comments yet.</p>;
  }

  return (
    <ul className="space-y-4">
      {nodes.map((node) => {
        const avatarHref = safeExternalHref(node.authorAvatarUrl);
        const sensitive = isSensitive(node.labels);
        const isOwn = viewerDid != null && viewerDid === node.authorDid;
        const continueHref = node.hasMore ? bskyPermalink(node.uri) : null;

        return (
          <li key={node.uri} style={{ marginLeft: node.depth * INDENT_PX }} className="flex gap-3">
            {avatarHref ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarHref}
                alt=""
                width={32}
                height={32}
                loading="lazy"
                className="h-8 w-8 flex-none rounded-full object-cover"
              />
            ) : (
              <div className="h-8 w-8 flex-none rounded-full bg-zinc-800" />
            )}
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-2 text-sm">
                <span className="font-medium text-zinc-100">{node.authorHandle}</span>
                <span className="text-xs text-zinc-500">{relativeTime(new Date(node.createdAt))}</span>
              </p>

              <SensitiveText sensitive={sensitive}>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-300">{node.text}</p>
              </SensitiveText>

              <div className="mt-1 flex items-center gap-3">
                {isOwn ? (
                  <form action={deleteComment}>
                    <input type="hidden" name="recordUri" value={node.uri} />
                    <button type="submit" className="text-xs text-zinc-600 hover:text-red-400">
                      Delete
                    </button>
                  </form>
                ) : null}
                {continueHref ? (
                  <a
                    href={continueHref}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-xs text-sky-400 hover:text-sky-300"
                  >
                    Continue this thread on Bluesky
                  </a>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
