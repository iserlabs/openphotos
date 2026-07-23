import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { photographers, photos, engagement, interactions, pushNotification, ABSORPTION_GRACE_MS, type Db } from "@luminance/db";
import type { PostView, ThreadView, LikeView, ActorView } from "@luminance/atproto";
import { graphemeSlice } from "@luminance/atproto";
import { Sentry, sentryEnabled } from "./sentry.js";

// ---- Injected AppView surface ---------------------------------------------
// Structural (not the concrete `AppView` class) so tests can inject a plain
// stub object that records calls (spec §5 test plan) instead of standing up
// a real AppView + fetchJson fixture server.
export interface EngagementAppView {
  getPosts(uris: string[]): Promise<PostView[]>;
  getPostThread(uri: string, depth?: number): Promise<ThreadView>;
  getLikes(uri: string, limit?: number): Promise<LikeView[]>;
  getFollowers(did: string, limit?: number): Promise<ActorView[]>;
}

export interface EngagementSweepOpts {
  likesPageSize?: number;
  sweepIndex?: number;
}

export interface SweepResult {
  requestsPerSweep: number;
  intervalMs: number;
  aborted: boolean;
}

const BASE_INTERVAL_MS = 180_000; // 3 min base (spec §5)
// 240 = 40% of the ~600 req/min public AppView budget; at ~200 requests/sweep
// the 3-min base holds (plan fix 890429c — per-minute budget, not per-5-min).
const RATE_BUDGET_PER_MIN = 240;
const FOLLOWER_DIFF_EVERY = 5; // least time-sensitive kind (spec §5)
const STALENESS_THRESHOLD_S = 30 * 60; // spec §5
const SNIPPET_LEN = 140;

/**
 * Detects a 429 from whatever shape the fetch layer surfaces it in:
 * `safeJsonFetch` throws `Error("fetch <url>: 429")`, but we also accept a
 * `status`/`statusCode` property in case a future fetch layer (or a test
 * stub) attaches one instead of encoding it in the message.
 */
export function isRateLimited(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown };
  if (e.status === 429 || e.statusCode === 429) return true;
  return typeof e.message === "string" && /\b429\b/.test(e.message);
}

export function governedIntervalMs(requestsPerSweep: number): number {
  return Math.max(BASE_INTERVAL_MS, Math.ceil((requestsPerSweep / RATE_BUDGET_PER_MIN) * 60_000));
}

type ScopedPost = { atUri: string; did: string; handle: string };

/** DISTINCT bsky-source post URIs of ACTIVE registered photographers only (spec §5). */
async function scopedPosts(db: Db): Promise<ScopedPost[]> {
  return db.selectDistinct({ atUri: photos.atUri, did: photographers.did, handle: photographers.handle })
    .from(photos)
    .innerJoin(photographers, eq(photos.did, photographers.did))
    .where(and(eq(photos.source, "bsky"), eq(photographers.status, "active")));
}

async function activePhotographers(db: Db): Promise<{ did: string; handle: string }[]> {
  return db.select({ did: photographers.did, handle: photographers.handle })
    .from(photographers)
    .where(eq(photographers.status, "active"));
}

/** Oldest fetchedAt among in-scope posts' EXISTING engagement rows, measured
 * before this tick's own upserts overwrite them — a sweep that keeps aborting
 * (429s, bugs) shows up here as growing lag, mirroring cursor-lag in main.ts. */
function checkStaleness(prevRows: { fetchedAt: Date }[]): void {
  if (!prevRows.length) return;
  const oldest = prevRows.reduce((min, r) => (r.fetchedAt < min ? r.fetchedAt : min), prevRows[0].fetchedAt);
  const staleSeconds = Math.floor((Date.now() - oldest.getTime()) / 1000);
  if (staleSeconds > STALENESS_THRESHOLD_S) {
    const msg = `engagement_staleness_seconds=${staleSeconds}`;
    console.error(msg);
    if (sentryEnabled) Sentry.captureMessage(msg, "error");
  }
}

async function notifyReplies(db: Db, nodes: ThreadView[], photographerDid: string, rootUri: string): Promise<void> {
  for (const node of nodes) {
    const author = node.post?.author;
    if (author && author.did !== photographerDid) {
      await pushNotification(db, {
        recipientDid: photographerDid,
        actorDid: author.did,
        actorHandle: author.handle,
        actorAvatarUrl: author.avatar ?? null,
        kind: "comment",
        subjectUri: node.post.uri,
        linkUri: rootUri,
        // grapheme-safe: a bare .slice(0, 140) would split surrogate pairs /
        // multi-code-point emoji at the boundary (matches commentOnPhoto).
        snippet: graphemeSlice(node.post.record?.text ?? "", SNIPPET_LEN),
      });
    }
    if (node.replies?.length) await notifyReplies(db, node.replies, photographerDid, rootUri);
  }
}

/** Deletes soft-deleted `interactions` whose subject's engagement has already
 * absorbed the delete BEYOND the grace window (deletedAt < fetchedAt − GRACE).
 * Aligned with `engagementFor`'s never-regress boundary: a soft-deleted row
 * still inside the grace window is treated as unabsorbed there (its -1 still
 * applies), so we must NOT prune it yet or the delta and the prune would
 * disagree. A subject with no engagement row is left alone — the inner join
 * naturally excludes it (spec: "leave those"). */
async function pruneAbsorbedInteractions(db: Db): Promise<void> {
  const toPrune = await db.select({ recordUri: interactions.recordUri })
    .from(interactions)
    .innerJoin(engagement, eq(interactions.subjectUri, engagement.postUri))
    .where(and(
      isNotNull(interactions.deletedAt),
      lt(interactions.deletedAt, sql`${engagement.fetchedAt} - ${sql.raw(String(ABSORPTION_GRACE_MS))} * interval '1 millisecond'`),
    ));
  if (toPrune.length) {
    await db.delete(interactions).where(inArray(interactions.recordUri, toPrune.map((r) => r.recordUri)));
  }
}

/**
 * The actual sweep tick. Exported (alongside the two documented entry points)
 * so both `runEngagementSweep` (one-shot, `Promise<void>` per spec) and
 * `startEngagementSweep`'s scheduler (which needs the governed interval to
 * chain the next `setTimeout`) share one implementation.
 */
export async function sweepOnce(db: Db, appview: EngagementAppView, opts: EngagementSweepOpts = {}): Promise<SweepResult> {
  const likesPageSize = opts.likesPageSize ?? 100;
  const sweepIndex = opts.sweepIndex ?? 0;
  const now = new Date();

  let postRequests = 0;
  let likeRequests = 0;
  let replyRequests = 0;
  let followerRequests = 0;
  let aborted = false;

  // The WHOLE tick is inside the try — scope query, prev-rows read, the fan-out
  // loops, AND the prune — so any failure (a 429 mid-loop, a transient DB blip
  // on the scope/prev reads) aborts THIS tick cleanly and the function always
  // resolves. 429-abort semantics are unchanged: rows upserted before the throw
  // are kept, and the next tick resumes from current DB state.
  try {
    const scoped = await scopedPosts(db);
    const postUris = scoped.map((s) => s.atUri);
    const photographerByUri = new Map(scoped.map((s) => [s.atUri, { did: s.did, handle: s.handle }]));

    const prevRows = postUris.length ? await db.select().from(engagement).where(inArray(engagement.postUri, postUris)) : [];
    const prevByUri = new Map(prevRows.map((r) => [r.postUri, r]));
    checkStaleness(prevRows);

    if (postUris.length) {
      postRequests = Math.ceil(postUris.length / 25);
      const posts = await appview.getPosts(postUris);
      for (const post of posts) {
        const photographer = photographerByUri.get(post.uri);
        if (!photographer) continue; // defensive: appview returned something out of scope

        const prev = prevByUri.get(post.uri);
        await db.insert(engagement).values({
          postUri: post.uri, likeCount: post.likeCount, replyCount: post.replyCount,
          repostCount: post.repostCount, fetchedAt: now,
        }).onConflictDoUpdate({
          target: engagement.postUri,
          set: { likeCount: post.likeCount, replyCount: post.replyCount, repostCount: post.repostCount, fetchedAt: now },
        });

        // Baseline seeding: a post with NO previous engagement row is a
        // first-ever sweep — its counts are historical, not news. We upsert the
        // row (above) but fire ZERO like/reply notifications; a rise only fires
        // against an existing baseline. Without this, the first sweep would
        // flood the photographer with a notification per pre-existing like/reply.
        const likeRose = prev ? post.likeCount > prev.likeCount : false;
        const replyRose = prev ? post.replyCount > prev.replyCount : false;

        if (likeRose) {
          likeRequests++;
          const likes = await appview.getLikes(post.uri, likesPageSize);
          for (const like of likes) {
            if (like.actor.did === photographer.did) continue; // no self-notification
            await pushNotification(db, {
              recipientDid: photographer.did, actorDid: like.actor.did,
              actorHandle: like.actor.handle, actorAvatarUrl: like.actor.avatar ?? null,
              kind: "like", subjectUri: post.uri, linkUri: post.uri,
            });
          }
        }

        if (replyRose) {
          replyRequests++;
          const thread = await appview.getPostThread(post.uri);
          await notifyReplies(db, thread.replies ?? [], photographer.did, post.uri);
        }
      }
    }

    if (sweepIndex % FOLLOWER_DIFF_EVERY === 0) {
      // Follower diff is intentionally NOT baseline-gated like likes/replies
      // above: it's bounded (≤100 followers per call) and notifications dedupe
      // forever on their unique key, so the very first sweep backfills a
      // one-time burst of follow notifications for pre-existing followers. That
      // one-time backfill is accepted (bounded + deduped); every later sweep
      // only ever surfaces genuinely new followers.
      const scopePhotographers = await activePhotographers(db);
      followerRequests = scopePhotographers.length;
      for (const p of scopePhotographers) {
        const followers = await appview.getFollowers(p.did, 100);
        for (const follower of followers) {
          if (follower.did === p.did) continue; // no self-notification
          await pushNotification(db, {
            recipientDid: p.did, actorDid: follower.did, actorHandle: follower.handle,
            actorAvatarUrl: follower.avatar ?? null, kind: "follow",
            subjectUri: p.did, linkUri: `/${p.handle}`,
          });
        }
      }
    }

    await pruneAbsorbedInteractions(db);
  } catch (err) {
    aborted = true;
    if (isRateLimited(err)) {
      console.error("engagement_sweep: rate limited, aborting tick (rows already upserted this tick are kept)", String(err));
    } else {
      console.error("engagement_sweep: tick failed, aborting", err);
    }
  }

  const requestsPerSweep = postRequests + likeRequests + replyRequests + followerRequests;
  const intervalMs = governedIntervalMs(requestsPerSweep);
  console.log(`engagement_sweep interval_ms=${intervalMs} requests=${requestsPerSweep}`);

  return { requestsPerSweep, intervalMs, aborted };
}

/** One-shot sweep tick. Errors (incl. 429s) are caught internally — the tick
 * aborts cleanly and this always resolves; rows upserted before the abort
 * point are kept, and the next call resumes from current DB state. */
export async function runEngagementSweep(db: Db, appview: EngagementAppView, opts: EngagementSweepOpts = {}): Promise<void> {
  await sweepOnce(db, appview, opts);
}

/**
 * setTimeout-chaining loop (not `setInterval`) so each tick's governed
 * interval — computed from that tick's own request count — applies to the
 * NEXT delay, per the scale governor (spec §5).
 */
export function startEngagementSweep(db: Db, appview: EngagementAppView, opts: EngagementSweepOpts = {}): { stop(): void } {
  let stopped = false;
  let sweepIndex = opts.sweepIndex ?? 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(tick, delayMs);
  };

  const tick = () => {
    void sweepOnce(db, appview, { ...opts, sweepIndex })
      .then((result) => {
        sweepIndex++;
        scheduleNext(result.intervalMs);
      })
      .catch((err) => {
        // sweepOnce already swallows its own errors — this is a
        // belt-and-suspenders guard (backfill-loop style) so a bug here can
        // never crash the process or stall the chain.
        console.error("engagement sweep: tick failed unexpectedly, will retry at base interval", err);
        sweepIndex++;
        scheduleNext(BASE_INTERVAL_MS);
      });
  };

  scheduleNext(BASE_INTERVAL_MS);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
