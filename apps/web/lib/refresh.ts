import { eq } from "drizzle-orm";
import { photographers, type Db } from "@openphotos/db";

export type RefreshResult = { ok: boolean; error?: string; alreadyRunning?: boolean };

/**
 * Photographer-initiated re-index: re-arms the ingestor's reconciliation walk
 * (backfill_status='pending'; the 10s loop picks it up, PDS truth wins).
 * Exists because the public Jetstream feed has been observed starving this
 * PDS's events for 24h+ — this gives sub-minute freshness on demand instead
 * of waiting out the periodic reconcile. Idempotent: an already pending or
 * running walk is reported, not duplicated.
 */
export async function requestRefresh(db: Db, sessionDid: string | null | undefined): Promise<RefreshResult> {
  if (!sessionDid) return { ok: false, error: "sign in first" };
  const [me] = await db
    .select({ backfillStatus: photographers.backfillStatus, status: photographers.status })
    .from(photographers)
    .where(eq(photographers.did, sessionDid));
  if (!me || me.status !== "active") return { ok: false, error: "not a registered photographer" };
  if (me.backfillStatus === "pending" || me.backfillStatus === "running") {
    return { ok: true, alreadyRunning: true };
  }
  await db.update(photographers).set({ backfillStatus: "pending" }).where(eq(photographers.did, sessionDid));
  return { ok: true };
}
