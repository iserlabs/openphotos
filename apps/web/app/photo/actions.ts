"use server";

import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getPhotoRecord } from "@/lib/queries";
import { routeInteraction, likePhoto, unlikePhoto, restoreAgent, RateLimitError } from "@/lib/interactions";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Server actions for the photo page's like button. Both are session-checked,
 * dispatch to the `lib/interactions.ts` service, and translate every failure
 * mode — including a rate-limit rejection — into `{ok:false, error}` so the
 * client component never has to catch a thrown server-action error.
 */
export async function likeAction(formData: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session.did) return { ok: false, error: "sign in to like this photo" };

  const atUri = String(formData.get("atUri") ?? "");
  if (!atUri) return { ok: false, error: "missing photo" };

  const db = getDb();
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

export async function unlikeAction(formData: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session.did) return { ok: false, error: "sign in to like this photo" };

  const atUri = String(formData.get("atUri") ?? "");
  if (!atUri) return { ok: false, error: "missing photo" };

  const db = getDb();
  try {
    return await unlikePhoto(db, (did) => restoreAgent(db, did), session.did, atUri);
  } catch (err) {
    if (err instanceof RateLimitError) return { ok: false, error: "Slow down — you're interacting a lot right now." };
    return { ok: false, error: "something went wrong — please try again" };
  }
}
