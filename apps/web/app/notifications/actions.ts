"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { markReadFor, markAllReadFor } from "@/lib/notifications";

/**
 * Mark specific notifications read. The recipient is always the SESSION's
 * DID — `ids` only tells `markReadFor` which of the caller's own rows to
 * touch, never whose rows they are. All the actual scoping/gating (session
 * required, must be a registered photographer) lives in `markReadFor`
 * (unit-tested directly in lib/notifications.test.ts); this stays a thin
 * session lookup so it doesn't need its own DB-backed test.
 */
export async function markReadAction(ids: number[]): Promise<void> {
  const session = await getSession();
  await markReadFor(getDb(), session.did, ids);
  revalidatePath("/notifications");
}

/** Same session-scoping as {@link markReadAction}, for the badge-only "mark all read" case. */
export async function markAllReadAction(): Promise<void> {
  const session = await getSession();
  await markAllReadFor(getDb(), session.did);
  revalidatePath("/notifications");
}
