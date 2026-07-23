"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { photographers } from "@luminance/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { requestRefresh } from "@/lib/refresh";
import {
  setHiddenForDid,
  deregisterDid,
  updateSourceToggles,
  adminTakedown as adminTakedownRow,
} from "@/lib/registration";

/**
 * Toggle a single photo's `hidden` state. Ownership is enforced in
 * `setHiddenForDid` against the session DID — the form only supplies the photo
 * reference, never whose photo it is.
 */
export async function setPhotoHidden(formData: FormData) {
  const session = await getSession();
  if (!session.did) redirect("/register?error=session");

  const atUri = String(formData.get("atUri") ?? "");
  const mediaIndex = Number(formData.get("mediaIndex") ?? "");
  const hidden = formData.get("hidden") === "true";
  if (!atUri || !Number.isInteger(mediaIndex)) redirect("/settings");

  await setHiddenForDid(getDb(), session.did, atUri, mediaIndex, hidden);
  revalidatePath("/settings");
}

/**
 * Update which sources are indexed. Writes ONLY the two toggle columns (never
 * `status`, so it can't implicitly reactivate a deregistered account) and
 * re-arms the backfill. Rows for a disabled source are purged in
 * `updateSourceToggles`.
 */
export async function updateSources(formData: FormData) {
  const session = await getSession();
  if (!session.did) redirect("/register?error=session");

  const db = getDb();
  const [p] = await db
    .select({ did: photographers.did })
    .from(photographers)
    .where(eq(photographers.did, session.did));
  if (!p) redirect("/register");

  const includeBsky = formData.get("includeBsky") != null;
  const includeGrain = formData.get("includeGrain") != null;
  await updateSourceToggles(db, session.did, { includeBsky, includeGrain });
  revalidatePath("/settings");
}

/** Deregister the signed-in photographer and send them home. */
export async function deregister() {
  const session = await getSession();
  if (!session.did) redirect("/register?error=session");

  await deregisterDid(getDb(), session.did);
  redirect("/");
}

/**
 * Admin-only takedown of any photo. Re-checks `isAdmin` on the server — render-time
 * gating of the form is not a security boundary.
 */
export async function adminTakedown(formData: FormData) {
  const session = await getSession();
  if (!session.isAdmin) redirect("/settings");

  const atUri = String(formData.get("atUri") ?? "");
  const mediaIndex = Number(formData.get("mediaIndex") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!atUri || !Number.isInteger(mediaIndex)) redirect("/settings");

  await adminTakedownRow(getDb(), atUri, mediaIndex, reason);
  revalidatePath("/settings");
}

/**
 * Photographer-initiated re-index (see lib/refresh.ts). Full containment: any
 * unexpected throw stays server-side; the page re-renders with fresh status.
 */
export async function refreshPhotos() {
  try {
    const session = await getSession();
    await requestRefresh(getDb(), session.did ?? null);
    revalidatePath("/settings");
  } catch {
    // Swallow — the settings page's status line reflects reality on rerender.
  }
}
