import { eq } from "drizzle-orm";
import { photographers, markRead, markAllRead, type Db } from "@luminance/db";

/** Registered-photographer check — only photographers ever receive notifications. */
async function isPhotographerDid(db: Db, did: string): Promise<boolean> {
  const [row] = await db.select({ did: photographers.did }).from(photographers).where(eq(photographers.did, did));
  return row != null;
}

/**
 * Session-scoped mark-read: `sessionDid` must come straight from
 * `getSession()` in the caller (see `app/notifications/actions.ts`) — never
 * a client-supplied param — so a request can only ever touch its OWN
 * recipient's rows. `markRead` itself also scopes the update to
 * `recipientDid`, so passing another recipient's ids here is a no-op rather
 * than a leak either way; this is defense in depth, not the only guard.
 *
 * Signed-out and non-photographer sessions no-op: only registered
 * photographers have notification rows to mark.
 */
export async function markReadFor(db: Db, sessionDid: string | undefined, ids: number[]): Promise<void> {
  if (!sessionDid || !ids.length) return;
  if (!(await isPhotographerDid(db, sessionDid))) return;
  await markRead(db, sessionDid, ids);
}

/** Same session-scoping rules as {@link markReadFor}, for the badge-only "mark all read" case. */
export async function markAllReadFor(db: Db, sessionDid: string | undefined): Promise<void> {
  if (!sessionDid) return;
  if (!(await isPhotographerDid(db, sessionDid))) return;
  await markAllRead(db, sessionDid);
}
