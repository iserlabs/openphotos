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
import { buildLikeRecord } from "@luminance/atproto";
import { getOAuthClient } from "./oauth";
import { splitAtUri } from "./queries";

const LIKE_COLLECTION = "app.bsky.feed.like";

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

async function isRegisteredPhotographer(db: Db, did: string): Promise<boolean> {
  const [row] = await db
    .select({ did: photographers.did })
    .from(photographers)
    .where(and(eq(photographers.did, did), eq(photographers.status, "active")));
  return row != null;
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
): Promise<ServiceResult> {
  await assertRateLimit(db, actorDid);

  const agent = await agentFactory(actorDid);
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
    if (subject.photographerDid !== actorDid && (await isRegisteredPhotographer(db, subject.photographerDid))) {
      await pushNotification(db, {
        recipientDid: subject.photographerDid,
        actorDid,
        actorHandle: subject.actorHandle,
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
  const agent = await agentFactory(actorDid);
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
