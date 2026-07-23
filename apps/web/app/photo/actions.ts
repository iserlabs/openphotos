"use server";

import type { Db } from "@luminance/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getPhotoRecord } from "@/lib/queries";
import { routeInteraction, likePhoto, unlikePhoto, restoreAgent, RateLimitError } from "@/lib/interactions";

type ActionResult = { ok: true } | { ok: false; error: string };

type SessionLike = { did?: string; handle?: string };

/**
 * Pure core for likeAction: no coupling to iron-session or Next context.
 * Wrap with try/catch in the server action to handle getSession/getDb failures.
 */
export async function likeActionCore(
  db: Db,
  session: SessionLike,
  formData: FormData,
): Promise<ActionResult> {
  if (!session.did) return { ok: false, error: "sign in to like this photo" };

  const atUri = String(formData.get("atUri") ?? "");
  if (!atUri) return { ok: false, error: "missing photo" };

  const record = await getPhotoRecord(db, atUri);
  if (!record) return { ok: false, error: "photo not found" };

  const routed = routeInteraction(record.items[0]);
  if (!routed.supported) return { ok: false, error: "interactions arrive with portfolio publishing" };

  try {
    return await likePhoto(db, (did) => restoreAgent(db, did), session.did, {
      uri: routed.subject.uri,
      cid: routed.subject.cid,
      photographerDid: record.photographer.did,
      photoLinkUri: atUri,
      actorHandle: session.handle ?? session.did,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return { ok: false, error: "Slow down — you're interacting a lot right now." };
    return { ok: false, error: "something went wrong — please try again" };
  }
}

/**
 * Server actions for the photo page's like button. Both are session-checked,
 * dispatch to the `lib/interactions.ts` service, and translate every failure
 * mode — including a rate-limit rejection — into `{ok:false, error}` so the
 * client component never has to catch a thrown server-action error.
 * The entire body is wrapped in try/catch to ensure getSession() and getDb()
 * errors never escape as uncaught server-action errors.
 */
export async function likeAction(formData: FormData): Promise<ActionResult> {
  try {
    const session = await getSession();
    const db = getDb();
    return await likeActionCore(db, session, formData);
  } catch (err) {
    return { ok: false, error: "something went wrong — please try again" };
  }
}

/**
 * Pure core for unlikeAction: no coupling to iron-session or Next context.
 */
export async function unlikeActionCore(
  db: Db,
  session: SessionLike,
  formData: FormData,
): Promise<ActionResult> {
  if (!session.did) return { ok: false, error: "sign in to like this photo" };

  const atUri = String(formData.get("atUri") ?? "");
  if (!atUri) return { ok: false, error: "missing photo" };

  try {
    return await unlikePhoto(db, (did) => restoreAgent(db, did), session.did, atUri);
  } catch (err) {
    if (err instanceof RateLimitError) return { ok: false, error: "Slow down — you're interacting a lot right now." };
    return { ok: false, error: "something went wrong — please try again" };
  }
}

export async function unlikeAction(formData: FormData): Promise<ActionResult> {
  try {
    const session = await getSession();
    const db = getDb();
    return await unlikeActionCore(db, session, formData);
  } catch (err) {
    return { ok: false, error: "something went wrong — please try again" };
  }
}
