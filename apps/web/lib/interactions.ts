import { and, eq } from "drizzle-orm";
import { Agent } from "@atproto/api";
import {
  photographers,
  recordInteraction,
  softDeleteInteraction,
  findInteraction,
  interactionWritesInWindow,
  pushNotification,
  type Db,
} from "@luminance/db";
import { AppView, buildLikeRecord, buildReplyRecord, buildFollowRecord, graphemeSlice } from "@luminance/atproto";
import { getOAuthClient } from "./oauth";
import { splitAtUri } from "./queries";
import { SESSION_EXPIRED_ERROR } from "./interaction-errors";

const LIKE_COLLECTION = "app.bsky.feed.like";
const POST_COLLECTION = "app.bsky.feed.post";
const FOLLOW_COLLECTION = "app.bsky.graph.follow";

// ---- router (spec §2) -----------------------------------------------------

/**
 * One function, keyed on `photo.source`: bsky-source photos map onto a real
 * `app.bsky.feed.like` subject (their underlying post's uri+cid); luminance/
 * grain photos have no interaction lexicon yet (phase 3 fills this branch —
 * see design doc §2/§10). The UI renders `{supported:false}` as a disabled row.
 */
export function routeInteraction(
  photo: { source: string; atUri: string; recordCid: string },
): { supported: true; subject: { uri: string; cid: string } } | { supported: false } {
  if (photo.source === "bsky") {
    return { supported: true, subject: { uri: photo.atUri, cid: photo.recordCid } };
  }
  return { supported: false };
}

// ---- rate limit (spec §4) --------------------------------------------------

export const RATE_LIMIT = { max: 30, windowMs: 300_000 } as const;

export class RateLimitError extends Error {
  constructor(message = "too many interactions — slow down and try again shortly") {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Per-actor write throttle: at most `RATE_LIMIT.max` interaction writes per
 * `RATE_LIMIT.windowMs`, counted over `interactions` rows created in the
 * window — soft-deleted rows count too (an unlike/relike cycle is still
 * write pressure). Only gates *writes* (like/comment/follow); unlike/unfollow
 * don't create new `interactions` rows so aren't throttled here.
 */
export async function assertRateLimit(db: Db, actorDid: string): Promise<void> {
  const count = await interactionWritesInWindow(db, actorDid, RATE_LIMIT.windowMs);
  if (count >= RATE_LIMIT.max) throw new RateLimitError();
}

// ---- agent seam -------------------------------------------------------------

export type AgentFactory = (did: string) => Promise<Agent>;

/**
 * Production `AgentFactory`: restores the viewer's persisted OAuth session and
 * wraps it in an `Agent`.
 *
 * VERIFY-API: the installed `@atproto/oauth-client@0.7.11` (via
 * `@atproto/oauth-client-node@0.4.9`) — see
 * `node_modules/.pnpm/@atproto+oauth-client@0.7.11/node_modules/@atproto/oauth-client/dist/oauth-client.js`
 * — `client.restore(did)` returns an `OAuthSession` exposing a `did` getter
 * and a `fetchHandler` method (see `oauth-session.d.ts`), which is exactly the
 * `SessionManager` shape the installed `@atproto/api@0.20.31` `Agent`
 * constructor accepts directly (`dist/session-manager.d.ts`: `SessionManager
 * extends FetchHandlerObject { readonly did?: string }`; `dist/agent.js`
 * constructor takes it as-is when `'fetchHandler' in options`). No adapter
 * needed — `new Agent(session)` is the whole implementation.
 */
export async function restoreAgent(db: Db, did: string): Promise<Agent> {
  const client = await getOAuthClient(db);
  const session = await client.restore(did);
  return new Agent(session);
}

/**
 * Calls the agent factory, translating a restore failure (revoked/expired
 * OAuth session — `client.restore` throws) into the {@link SESSION_EXPIRED_ERROR}
 * sentinel so client components can route the viewer to re-auth instead of
 * rendering a dead generic error. Every interaction below goes through this.
 */
async function getAgentOrExpired(
  agentFactory: AgentFactory,
  actorDid: string,
): Promise<{ agent: Agent } | { agent: null; error: string }> {
  try {
    return { agent: await agentFactory(actorDid) };
  } catch {
    return { agent: null, error: SESSION_EXPIRED_ERROR };
  }
}

/**
 * Best-effort actor-avatar snapshot for write-through notifications (the
 * sweep path snapshots avatars; this fills the same field at interaction
 * time so fresh notifications aren't avatar-less). Public AppView lookup,
 * null on any failure — never blocks or fails the interaction.
 */
export async function resolveActorAvatar(did: string): Promise<string | null> {
  try {
    return (await new AppView().getProfile(did)).avatar ?? null;
  } catch {
    return null;
  }
}

type InteractionDeps = { resolveAvatar?: (did: string) => Promise<string | null> };
const NO_AVATAR = async () => null;

// ---- like / unlike (spec §4) ------------------------------------------------

export type LikeSubject = {
  /** The underlying post's at-uri (from `routeInteraction`'s subject). */
  uri: string;
  /** The underlying post's record cid (from `routeInteraction`'s subject). */
  cid: string;
  /** DID of the photo's photographer — notification recipient (unless self-like). */
  photographerDid: string;
  /** The photo page's at-uri — notification `linkUri` (spec §3). */
  photoLinkUri: string;
  /** Viewer's handle, for the denormalized notification snapshot. */
  actorHandle: string;
};

type ServiceResult = { ok: true } | { ok: false; error: string };

/**
 * The single active-photographer lookup (consolidation of the former
 * `isRegisteredPhotographer` boolean twin — callers needing only existence
 * compare against null). Returns did + handle. The handle MUST come from this
 * server-side lookup, never from client-supplied input (a form field, or
 * anything else on a caller's target type), since the client can't be trusted
 * to submit its own notification routing.
 */
export async function getActivePhotographer(db: Db, did: string): Promise<{ did: string; handle: string } | null> {
  const [row] = await db
    .select({ did: photographers.did, handle: photographers.handle })
    .from(photographers)
    .where(and(eq(photographers.did, did), eq(photographers.status, "active")));
  return row ?? null;
}

/**
 * Like a photo: create `app.bsky.feed.like` in the viewer's own repo via
 * their OAuth agent, THEN write through to `interactions` (+ a notification
 * when the photographer is registered and isn't the actor themself).
 *
 * Ordering is load-bearing (spec §4): the PDS record is the source of truth,
 * created first; the DB half is second and best-effort — if it throws, the
 * engagement sweep heals the gap later, so we swallow it into `{ok:false}`
 * rather than let it crash the request (the like still landed on Bluesky).
 */
export async function likePhoto(
  db: Db,
  agentFactory: AgentFactory,
  actorDid: string,
  subject: LikeSubject,
  deps: InteractionDeps = {},
): Promise<ServiceResult> {
  await assertRateLimit(db, actorDid);

  const restored = await getAgentOrExpired(agentFactory, actorDid);
  if (!restored.agent) return { ok: false, error: restored.error };
  const agent = restored.agent;
  let created: { uri: string; cid: string };
  try {
    const res = await agent.com.atproto.repo.createRecord({
      repo: actorDid,
      collection: LIKE_COLLECTION,
      record: buildLikeRecord({ uri: subject.uri, cid: subject.cid }),
    });
    created = res.data;
  } catch {
    return { ok: false, error: "could not create the like on Bluesky" };
  }

  try {
    await recordInteraction(db, {
      recordUri: created.uri,
      actorDid,
      kind: "like",
      subjectUri: subject.uri,
      recordCid: created.cid,
    });
    if (subject.photographerDid !== actorDid && (await getActivePhotographer(db, subject.photographerDid))) {
      await pushNotification(db, {
        recipientDid: subject.photographerDid,
        actorDid,
        actorHandle: subject.actorHandle,
        actorAvatarUrl: await (deps.resolveAvatar ?? NO_AVATAR)(actorDid),
        kind: "like",
        subjectUri: subject.uri,
        linkUri: subject.photoLinkUri,
        snippet: null,
      });
    }
  } catch {
    // The PDS record exists; the sweep will reconcile it. Never crash here.
    return { ok: false, error: "liked on Bluesky, but syncing to Luminance failed — it will appear shortly" };
  }

  return { ok: true };
}

const LIST_RECORDS_PAGE_CAP = 10;
const LIST_RECORDS_PAGE_SIZE = 100;

/**
 * Missing-row fallback for unlike: the viewer's local `interactions` row is
 * gone (or never existed — e.g. they liked from the Bluesky app directly), so
 * page their own `app.bsky.feed.like` collection looking for a record whose
 * `subject.uri` matches, capped at {@link LIST_RECORDS_PAGE_CAP} pages so an
 * unbounded like history can't hang the request.
 */
async function findLikeRkeyByPaging(agent: Agent, actorDid: string, subjectUri: string): Promise<string | null> {
  let cursor: string | undefined;
  for (let page = 0; page < LIST_RECORDS_PAGE_CAP; page++) {
    const res = await agent.com.atproto.repo.listRecords({
      repo: actorDid,
      collection: LIKE_COLLECTION,
      limit: LIST_RECORDS_PAGE_SIZE,
      cursor,
    });
    const match = res.data.records.find(
      (r) => (r.value as { subject?: { uri?: string } }).subject?.uri === subjectUri,
    );
    if (match) return splitAtUri(match.uri)?.rkey ?? null;
    cursor = res.data.cursor;
    if (!cursor) break;
  }
  return null;
}

/**
 * Unlike a photo: resolve the like record's rkey (from the stored
 * `interactions` row, falling back to paging the viewer's own likes — see
 * {@link findLikeRkeyByPaging}), `deleteRecord` it on the PDS, then soft-delete
 * the local row if one existed.
 */
export async function unlikePhoto(
  db: Db,
  agentFactory: AgentFactory,
  actorDid: string,
  subjectUri: string,
): Promise<ServiceResult> {
  const restored = await getAgentOrExpired(agentFactory, actorDid);
  if (!restored.agent) return { ok: false, error: restored.error };
  const agent = restored.agent;
  const existing = await findInteraction(db, actorDid, "like", subjectUri);

  // Try to parse rkey from stored record; fall back to paging if missing or unparseable
  let rkey: string | null = null;
  if (existing) {
    rkey = splitAtUri(existing.recordUri)?.rkey ?? null;
  }
  if (!rkey) {
    rkey = await findLikeRkeyByPaging(agent, actorDid, subjectUri);
  }
  if (!rkey) return { ok: false, error: "unlike in your Bluesky app" };

  try {
    await agent.com.atproto.repo.deleteRecord({ repo: actorDid, collection: LIKE_COLLECTION, rkey });
  } catch {
    return { ok: false, error: "could not remove the like on Bluesky" };
  }

  if (existing) {
    try {
      await softDeleteInteraction(db, existing.recordUri);
    } catch {
      return { ok: false, error: "unliked on Bluesky, but syncing to Luminance failed — it will appear shortly" };
    }
  }

  return { ok: true };
}

// ---- comment / delete-own-comment (spec §4) ---------------------------------

export type CommentInput = {
  /** The photo's underlying post — reply `root`, and the interactions row's `subjectUri`. */
  subject: { uri: string; cid: string };
  /** The record being replied to; defaults to `subject` for a top-level comment. */
  parent?: { uri: string; cid: string };
  text: string;
  /** DID of the photo's photographer — notification recipient (unless self-comment). */
  photographerDid: string;
  /** The photo page's at-uri — notification `linkUri` (spec §3). */
  photoLinkUri: string;
};

/**
 * Comment on a photo: create an `app.bsky.feed.post` reply in the viewer's own
 * repo, THEN write through to `interactions` (+ a notification when the
 * photographer is registered and isn't the actor themself).
 *
 * Mirrors {@link likePhoto}'s ordering contract (record-first; DB half is
 * best-effort). Rate limit is asserted first, before any PDS write — see the
 * Task 5 review carry: `assertRateLimit` has no shared enforcement point, so
 * every write path (like/comment/follow) must call it itself.
 *
 * Grapheme-count violations from `buildReplyRecord` are caught and surfaced as
 * `{ok:false, error}` — never a throw — so the UI can render inline validation
 * instead of an uncaught server-action error.
 */
export async function commentOnPhoto(
  db: Db,
  agentFactory: AgentFactory,
  actorDid: string,
  actorHandle: string,
  input: CommentInput,
  deps: InteractionDeps & { fetchParent?: (uri: string) => Promise<{ cid: string; rootUri: string | null } | null> } = {},
): Promise<ServiceResult> {
  await assertRateLimit(db, actorDid);

  const parent = input.parent ?? input.subject;
  // Parent-ref validation (reply-to-comment): a client-supplied parent that
  // isn't the photo's own post must be verified server-side before we build a
  // record around it — its cid must match, and it must actually belong to THIS
  // photo's thread (its reply root === our subject). Otherwise a crafted
  // parent could graft the viewer's reply onto an unrelated thread.
  if (input.parent && input.parent.uri !== input.subject.uri) {
    const fetchParent = deps.fetchParent ?? defaultFetchParent;
    let verified: { cid: string; rootUri: string | null } | null;
    try {
      verified = await fetchParent(input.parent.uri);
    } catch {
      verified = null;
    }
    if (!verified || verified.cid !== input.parent.cid || verified.rootUri !== input.subject.uri) {
      return { ok: false, error: "that comment can't be replied to" };
    }
  }

  let record: ReturnType<typeof buildReplyRecord>;
  try {
    record = buildReplyRecord(input.text, input.subject, parent);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid comment" };
  }

  const restored = await getAgentOrExpired(agentFactory, actorDid);
  if (!restored.agent) return { ok: false, error: restored.error };
  const agent = restored.agent;
  let created: { uri: string; cid: string };
  try {
    const res = await agent.com.atproto.repo.createRecord({
      repo: actorDid,
      collection: POST_COLLECTION,
      record,
    });
    created = res.data;
  } catch {
    return { ok: false, error: "could not create the comment on Bluesky" };
  }

  try {
    await recordInteraction(db, {
      recordUri: created.uri,
      actorDid,
      kind: "comment",
      subjectUri: input.subject.uri,
      text: input.text,
      recordCid: created.cid,
    });
    if (input.photographerDid !== actorDid && (await getActivePhotographer(db, input.photographerDid))) {
      await pushNotification(db, {
        recipientDid: input.photographerDid,
        actorDid,
        actorHandle,
        actorAvatarUrl: await (deps.resolveAvatar ?? NO_AVATAR)(actorDid),
        kind: "comment",
        // The reply's own record uri is the dedupe identity here (schema §3) —
        // unlike a like (one per post), a viewer can leave many comments on the
        // same photo and each is its own notification.
        subjectUri: created.uri,
        linkUri: input.photoLinkUri,
        // grapheme-safe: input.text.slice(0, 140) would split surrogate pairs
        // / multi-code-point emoji sequences at the boundary (spec review carry).
        snippet: graphemeSlice(input.text, 140),
      });
    }
  } catch {
    return { ok: false, error: "commented on Bluesky, but syncing to Luminance failed — it will appear shortly" };
  }

  return { ok: true };
}

/**
 * Delete the viewer's own comment: ownership is enforced by construction — the
 * record's repo DID (parsed from `recordUri`) must equal `actorDid` — before
 * ever touching the agent or the PDS.
 */
/**
 * Resolve a prospective reply parent via the public AppView: its current cid
 * and its thread root (`record.reply.root.uri`; null for a top-level post).
 * Returns null when the post doesn't exist or isn't visible.
 */
async function defaultFetchParent(uri: string): Promise<{ cid: string; rootUri: string | null } | null> {
  const [post] = await new AppView().getPosts([uri]);
  if (!post) return null;
  const record = post.record as { reply?: { root?: { uri?: string } } };
  return { cid: post.cid, rootUri: record.reply?.root?.uri ?? null };
}

export async function deleteOwnComment(
  db: Db,
  agentFactory: AgentFactory,
  actorDid: string,
  recordUri: string,
): Promise<ServiceResult> {
  if (!recordUri.startsWith(`at://${actorDid}/`)) {
    return { ok: false, error: "you can only delete your own comments" };
  }
  const parts = splitAtUri(recordUri);
  if (!parts) return { ok: false, error: "invalid comment" };
  // Collection guard: a comment is an app.bsky.feed.post reply. Ownership alone
  // is not enough — an actor owns their profile/like/follow records too, and a
  // crafted recordUri (e.g. app.bsky.actor.profile/self) would otherwise let
  // this deleteRecord a non-comment record in the viewer's own repo. Reject
  // anything that isn't a feed.post BEFORE touching the agent/PDS.
  if (parts.collection !== POST_COLLECTION) {
    return { ok: false, error: "not a comment" };
  }

  const restored = await getAgentOrExpired(agentFactory, actorDid);
  if (!restored.agent) return { ok: false, error: restored.error };
  try {
    await restored.agent.com.atproto.repo.deleteRecord({ repo: actorDid, collection: parts.collection, rkey: parts.rkey });
  } catch {
    return { ok: false, error: "could not delete the comment on Bluesky" };
  }

  try {
    await softDeleteInteraction(db, recordUri);
  } catch {
    return { ok: false, error: "deleted on Bluesky, but syncing to Luminance failed — it will appear shortly" };
  }

  return { ok: true };
}

// ---- follow / unfollow (spec §4) --------------------------------------------

export type FollowTarget = {
  photographerDid: string;
};

/**
 * Follow a photographer: create `app.bsky.graph.follow` in the viewer's own
 * repo, THEN write through to `interactions` (+ a notification when the
 * photographer is registered and isn't the actor themself).
 *
 * Rate limit is asserted first, before any PDS write (same trap as
 * {@link commentOnPhoto} — no shared enforcement point).
 *
 * The notification `linkUri` is built from {@link getActivePhotographer}'s
 * row, NOT from any client-supplied handle — `FollowTarget` intentionally
 * carries only `photographerDid`. A caller with a stale or spoofed handle
 * (e.g. a form field) has no way to influence where the notification links.
 */
export async function followPhotographer(
  db: Db,
  agentFactory: AgentFactory,
  actorDid: string,
  actorHandle: string,
  target: FollowTarget,
  deps: InteractionDeps = {},
): Promise<ServiceResult> {
  await assertRateLimit(db, actorDid);

  const restored = await getAgentOrExpired(agentFactory, actorDid);
  if (!restored.agent) return { ok: false, error: restored.error };
  const agent = restored.agent;

  // Push the follow notification per the normal gating (registered photographer,
  // not a self-follow). Shared by the adopt and create paths below so both stay
  // identical. linkUri is built from the DB row's handle, never client input.
  const pushFollowNotification = async () => {
    if (target.photographerDid === actorDid) return;
    const photographer = await getActivePhotographer(db, target.photographerDid);
    if (photographer) {
      await pushNotification(db, {
        recipientDid: photographer.did,
        actorDid,
        actorHandle,
        actorAvatarUrl: await (deps.resolveAvatar ?? NO_AVATAR)(actorDid),
        kind: "follow",
        subjectUri: target.photographerDid,
        linkUri: `/${photographer.handle}`,
        snippet: null,
      });
    }
  };

  // Dup-guard + record adoption: if the viewer already follows this actor,
  // getProfile returns their EXISTING follow record's at-uri in
  // `viewer.following`. Adopt it — write `interactions` keyed on that uri — and
  // return WITHOUT creating a second follow record. This kills duplicate PDS
  // records AND heals the button seam: findInteraction becomes truthy (the
  // FollowButton reads as "following") and unfollow resolves its rkey from the
  // adopted uri. Wrapped in try/catch: a getProfile failure prefers
  // availability over de-dup and falls through to the normal create path.
  let existingFollowUri: string | undefined;
  try {
    const { data } = await agent.app.bsky.actor.getProfile({ actor: target.photographerDid });
    existingFollowUri = data.viewer?.following;
  } catch {
    existingFollowUri = undefined;
  }

  if (existingFollowUri) {
    try {
      await recordInteraction(db, {
        recordUri: existingFollowUri,
        actorDid,
        kind: "follow",
        subjectUri: target.photographerDid,
      });
      await pushFollowNotification();
    } catch {
      return { ok: false, error: "followed on Bluesky, but syncing to Luminance failed — it will appear shortly" };
    }
    return { ok: true };
  }

  let created: { uri: string; cid: string };
  try {
    const res = await agent.com.atproto.repo.createRecord({
      repo: actorDid,
      collection: FOLLOW_COLLECTION,
      record: buildFollowRecord(target.photographerDid),
    });
    created = res.data;
  } catch {
    return { ok: false, error: "could not follow on Bluesky" };
  }

  try {
    await recordInteraction(db, {
      recordUri: created.uri,
      actorDid,
      kind: "follow",
      subjectUri: target.photographerDid,
    });
    await pushFollowNotification();
  } catch {
    return { ok: false, error: "followed on Bluesky, but syncing to Luminance failed — it will appear shortly" };
  }

  return { ok: true };
}

/**
 * Unfollow a photographer: resolve the follow record's rkey from the stored
 * `interactions` row and `deleteRecord` it, then soft-delete the local row.
 *
 * Unlike {@link unlikePhoto}, there is NO paging fallback here — a missing row
 * surfaces as `{ok:false}` pointing the viewer at the Bluesky app. Follows
 * aren't subject-scannable the same way (no stable per-photo subject uri to
 * match on), so the fallback isn't worth the complexity for this action.
 */
export async function unfollowPhotographer(
  db: Db,
  agentFactory: AgentFactory,
  actorDid: string,
  photographerDid: string,
): Promise<ServiceResult> {
  const existing = await findInteraction(db, actorDid, "follow", photographerDid);
  const rkey = existing ? splitAtUri(existing.recordUri)?.rkey : null;
  if (!existing || !rkey) return { ok: false, error: "unfollow in your Bluesky app" };

  const restored = await getAgentOrExpired(agentFactory, actorDid);
  if (!restored.agent) return { ok: false, error: restored.error };
  try {
    await restored.agent.com.atproto.repo.deleteRecord({ repo: actorDid, collection: FOLLOW_COLLECTION, rkey });
  } catch {
    return { ok: false, error: "could not unfollow on Bluesky" };
  }

  try {
    await softDeleteInteraction(db, existing.recordUri);
  } catch {
    return { ok: false, error: "unfollowed on Bluesky, but syncing to Luminance failed — it will appear shortly" };
  }

  return { ok: true };
}
