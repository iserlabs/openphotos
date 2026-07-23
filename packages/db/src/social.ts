import { and, eq, gt, inArray, isNull, sql, desc, lt } from "drizzle-orm";
import { interactions, engagement, notifications } from "./schema.js";
import type { Db } from "./client.js";

type NewInteraction = { recordUri: string; actorDid: string; kind: "like" | "comment" | "follow"; subjectUri: string; text?: string | null; recordCid?: string | null };

export async function recordInteraction(db: Db, row: NewInteraction) {
  await db.insert(interactions).values(row).onConflictDoNothing();
}
export async function softDeleteInteraction(db: Db, recordUri: string) {
  await db.update(interactions).set({ deletedAt: new Date() }).where(eq(interactions.recordUri, recordUri));
}
export async function findInteraction(db: Db, actorDid: string, kind: "like" | "comment" | "follow", subjectUri: string) {
  const [row] = await db.select().from(interactions)
    .where(and(eq(interactions.actorDid, actorDid), eq(interactions.kind, kind), eq(interactions.subjectUri, subjectUri), isNull(interactions.deletedAt)));
  return row ?? null;
}
export async function interactionWritesInWindow(db: Db, actorDid: string, windowMs: number) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(interactions)
    .where(and(eq(interactions.actorDid, actorDid), gt(interactions.createdAt, new Date(Date.now() - windowMs))));
  return r?.n ?? 0;
}

/**
 * Never-regress grace window. The absorption boundary is `fetchedAt - GRACE`,
 * not `fetchedAt` itself: the AppView indexes a like/comment/unlike ~1min after
 * it happens, so a sweep that fetches BEFORE that absorption still carries a
 * stale cached count. Counting a local delta as "absorbed" the instant its
 * timestamp predates `fetchedAt` would then DROP the viewer's own just-written
 * interaction (a visible regression). By treating anything within GRACE of the
 * fetch as still-unabsorbed, we keep the local delta applied — the spec
 * prioritizes never-regress over a brief (≤GRACE) double-count on the rare
 * sweep that WAS already fast enough to absorb it.
 */
export const ABSORPTION_GRACE_MS = 90_000;

export async function engagementFor(db: Db, postUris: string[]): Promise<Map<string, { likeCount: number; replyCount: number }>> {
  const out = new Map(postUris.map((u) => [u, { likeCount: 0, replyCount: 0 }]));
  if (!postUris.length) return out;
  const base = await db.select().from(engagement).where(inArray(engagement.postUri, postUris));
  const fetchedAt = new Map(base.map((b) => [b.postUri, b.fetchedAt]));
  for (const b of base) out.set(b.postUri, { likeCount: b.likeCount, replyCount: b.replyCount });
  // one grouped delta query (spec §3): creates/deletes not yet absorbed
  const deltas = await db.select({
    subjectUri: interactions.subjectUri, kind: interactions.kind,
    createdAt: interactions.createdAt, deletedAt: interactions.deletedAt,
  }).from(interactions).where(and(inArray(interactions.subjectUri, postUris), inArray(interactions.kind, ["like", "comment"])));
  for (const d of deltas) {
    const cur = out.get(d.subjectUri)!;
    const fa = fetchedAt.get(d.subjectUri) ?? new Date(0);
    // Absorption boundary sits GRACE before the fetch (see ABSORPTION_GRACE_MS).
    const boundary = new Date(fa.getTime() - ABSORPTION_GRACE_MS);
    const field = d.kind === "like" ? "likeCount" : "replyCount";
    // Two independent terms (spec §3): +1 for an unabsorbed create, -1 for an
    // unabsorbed delete. They are NOT exclusive branches — a row created AND
    // deleted after the boundary applies both (both-pending nets 0); a row
    // created before but deleted after applies only the delete (net -1); a row
    // with both timestamps older than the boundary is fully absorbed (0).
    if (d.createdAt > boundary) cur[field] += 1;
    if (d.deletedAt && d.deletedAt > boundary) cur[field] -= 1;
  }
  // Clamp: a still-pending unlike against an already-0 cached count would
  // otherwise render -1. Displayed counts are never negative.
  for (const counts of out.values()) {
    counts.likeCount = Math.max(0, counts.likeCount);
    counts.replyCount = Math.max(0, counts.replyCount);
  }
  return out;
}

type NewNotification = { recipientDid: string; actorDid: string; actorHandle: string; actorAvatarUrl?: string | null; kind: "like" | "comment" | "follow"; subjectUri: string; linkUri: string; snippet?: string | null };
export async function pushNotification(db: Db, row: NewNotification) {
  await db.insert(notifications).values(row).onConflictDoNothing();
}
export async function unreadCount(db: Db, recipientDid: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications)
    .where(and(eq(notifications.recipientDid, recipientDid), isNull(notifications.readAt)));
  return r?.n ?? 0;
}
export async function notificationsPage(db: Db, recipientDid: string, opts: { limit: number; cursor?: number }) {
  const rows = await db.select().from(notifications)
    .where(and(eq(notifications.recipientDid, recipientDid), opts.cursor ? lt(notifications.id, opts.cursor) : sql`true`))
    .orderBy(desc(notifications.id)).limit(opts.limit + 1);
  const items = rows.slice(0, opts.limit);
  return { items, cursor: rows.length > opts.limit ? items[items.length - 1].id : null };
}
export async function markRead(db: Db, recipientDid: string, ids: number[]) {
  if (!ids.length) return;
  await db.update(notifications).set({ readAt: new Date() })
    .where(and(eq(notifications.recipientDid, recipientDid), inArray(notifications.id, ids), isNull(notifications.readAt)));
}
export async function markAllRead(db: Db, recipientDid: string) {
  await db.update(notifications).set({ readAt: new Date() })
    .where(and(eq(notifications.recipientDid, recipientDid), isNull(notifications.readAt)));
}
