import { and, eq, isNull } from "drizzle-orm";
import { interactions, type Db } from "@openphotos/db";
import type { ThreadView } from "@openphotos/atproto";

/**
 * A single flattened comment row, ready to render. `depth` is 0 for a direct
 * reply to the photo's post, 1 for a reply-to-a-reply, etc. — capped at
 * `maxDepth - 1` (see {@link flattenThread}). `labels` carries the reply
 * post's moderation/self-label values (spec §7 blur-gate); `hasMore` is true
 * when this node has further replies that were clipped by `maxDepth`.
 */
export type CommentNode = {
  uri: string;
  cid: string;
  authorDid: string;
  authorHandle: string;
  authorAvatarUrl: string | undefined;
  text: string;
  createdAt: string;
  depth: number;
  labels: string[];
  hasMore: boolean;
};

// The `ThreadView`/`PostView` types imported above are deliberately narrow
// (packages/atproto/src/appview.ts) — they describe only the well-formed
// `threadViewPost` shape. The real AppView response is a union that also
// includes `blockedPost`/`notFoundPost` stub nodes wherever a reply was
// blocked, deleted, or otherwise hidden; those stubs carry no `.post` and no
// `.replies` at all. Because JSON parsing doesn't enforce TypeScript's types,
// such a stub can absolutely reach this function typed as `ThreadView` even
// though the field doesn't exist at runtime.
//
// ⚠ Carried from Task 3 review: flattening MUST treat these stubs as if the
// reply were simply absent (spec §7 — "blocked/hidden-reply stubs render as
// absent") rather than throwing when `.post`/`.replies` turn out to be
// undefined. `RawNode` below models the real (wider) wire shape so every
// access is guarded at runtime instead of trusted from the type.
type RawLabel = { val: string };
type RawNode = {
  post?: {
    uri: string;
    cid: string;
    author: { did: string; handle: string; avatar?: string; labels?: RawLabel[] };
    record: { text: string; createdAt?: string };
    labels?: RawLabel[];
    indexedAt?: string;
  };
  replies?: RawNode[];
};

/**
 * Flattens a `getPostThread` response into a depth-limited, render-ready
 * list of comments (spec §7: "2 levels deep, then 'continue this thread on
 * Bluesky'"). The root post itself is never included — only its replies.
 *
 * Depths `0..maxDepth-1` are included; a node at the deepest included depth
 * that itself has further replies is marked `hasMore: true` and its children
 * are dropped rather than flattened (the UI links out to Bluesky instead).
 *
 * Blocked/not-found reply stubs — recognizable at runtime by the absence of
 * `.post` — are skipped entirely, along with anything nested under them,
 * without throwing.
 */
export function flattenThread(thread: ThreadView, opts: { maxDepth: number }): CommentNode[] {
  const { maxDepth } = opts;
  const out: CommentNode[] = [];
  const root = thread as unknown as RawNode | null | undefined;

  function walk(nodes: RawNode[] | undefined, depth: number): void {
    if (!nodes) return;
    for (const node of nodes) {
      const post = node?.post;
      if (!post) continue; // blocked/notFound stub — render as absent

      const children = node.replies;
      const hasChildren = !!children && children.some((c) => c?.post != null);
      const clipped = depth >= maxDepth - 1 && hasChildren;

      out.push({
        uri: post.uri,
        cid: post.cid,
        authorDid: post.author.did,
        authorHandle: post.author.handle,
        authorAvatarUrl: post.author.avatar,
        text: post.record.text,
        createdAt: post.record.createdAt ?? post.indexedAt ?? "",
        depth,
        // Union of the reply's own labels AND its author's account-level
        // labels — an author-labeled account's replies must blur consistently
        // with how their photos blur (fast-follow: author-label blur union).
        labels: [...(post.labels ?? []), ...(post.author.labels ?? [])].map((l) => l.val),
        hasMore: clipped,
      });

      if (depth + 1 < maxDepth) walk(children, depth + 1);
    }
  }

  walk(root?.replies, 0);
  return out;
}

/**
 * The session user's own comments that the cached AppView thread doesn't show
 * yet — a comment just posted (write-through row exists) but not yet indexed by
 * the AppView (~1min lag) would otherwise vanish from the page until the next
 * revalidation. Mirrors the never-regress intent for engagement counts, applied
 * to comment visibility: the author always sees their own comment immediately.
 *
 * Queries the viewer's un-deleted `comment` interactions on this subject,
 * excludes any `recordUri` already flattened out of the thread (`existingUris`),
 * and maps the rest to depth-0 `CommentNode`s using the stored text and the
 * session handle (no avatar — we don't snapshot the viewer's avatar).
 */
export async function pendingOwnComments(
  db: Db,
  sessionDid: string,
  sessionHandle: string,
  atUri: string,
  existingUris: Set<string>,
): Promise<CommentNode[]> {
  const rows = await db
    .select()
    .from(interactions)
    .where(
      and(
        eq(interactions.kind, "comment"),
        eq(interactions.subjectUri, atUri),
        eq(interactions.actorDid, sessionDid),
        isNull(interactions.deletedAt),
      ),
    );
  return rows
    .filter((r) => !existingUris.has(r.recordUri))
    .map((r) => ({
      uri: r.recordUri,
      cid: r.recordCid ?? "",
      authorDid: sessionDid,
      authorHandle: sessionHandle,
      authorAvatarUrl: undefined,
      text: r.text ?? "",
      createdAt: r.createdAt.toISOString(),
      depth: 0,
      labels: [],
      hasMore: false,
    }));
}
