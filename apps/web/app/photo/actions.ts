"use server";

import { revalidateTag } from "next/cache";
import type { Db } from "@luminance/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getPhotoRecord } from "@/lib/queries";
import {
  routeInteraction,
  likePhoto,
  unlikePhoto,
  commentOnPhoto,
  deleteOwnComment,
  restoreAgent,
  resolveActorAvatar,
  RateLimitError,
} from "@/lib/interactions";

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
    return await likePhoto(
      db,
      (did) => restoreAgent(db, did),
      session.did,
      {
        uri: routed.subject.uri,
        cid: routed.subject.cid,
        photographerDid: record.photographer.did,
        photoLinkUri: atUri,
        actorHandle: session.handle ?? session.did,
      },
      { resolveAvatar: resolveActorAvatar },
    );
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

/**
 * Pure core for commentAction: no coupling to iron-session or Next context.
 * `parentUri`/`parentCid` are optional — omitted (or blank) for a top-level
 * comment, in which case `commentOnPhoto` defaults `parent` to `subject`.
 */
export async function commentActionCore(
  db: Db,
  session: SessionLike,
  formData: FormData,
): Promise<ActionResult> {
  if (!session.did) return { ok: false, error: "sign in to comment on this photo" };

  const atUri = String(formData.get("atUri") ?? "");
  const text = String(formData.get("text") ?? "");
  if (!atUri) return { ok: false, error: "missing photo" };

  const record = await getPhotoRecord(db, atUri);
  if (!record) return { ok: false, error: "photo not found" };

  const routed = routeInteraction(record.items[0]);
  if (!routed.supported) return { ok: false, error: "interactions arrive with portfolio publishing" };

  const parentUri = String(formData.get("parentUri") ?? "");
  const parentCid = String(formData.get("parentCid") ?? "");
  const parent = parentUri && parentCid ? { uri: parentUri, cid: parentCid } : undefined;

  try {
    return await commentOnPhoto(
      db,
      (did) => restoreAgent(db, did),
      session.did,
      session.handle ?? session.did,
      {
        subject: routed.subject,
        parent,
        text,
        photographerDid: record.photographer.did,
        photoLinkUri: atUri,
      },
      { resolveAvatar: resolveActorAvatar },
    );
  } catch (err) {
    if (err instanceof RateLimitError) return { ok: false, error: "Slow down — you're interacting a lot right now." };
    return { ok: false, error: "something went wrong — please try again" };
  }
}

/**
 * Server action for the photo page's comment box. Session-checked, dispatches
 * to `commentOnPhoto`, and translates every failure mode — including a
 * rate-limit rejection and a grapheme-count violation surfaced as
 * `{ok:false}` by the service — into a plain result. Entire body wrapped in
 * try/catch so getSession()/getDb() failures never escape uncaught.
 */
export async function commentAction(formData: FormData): Promise<ActionResult> {
  try {
    const session = await getSession();
    const db = getDb();
    const result = await commentActionCore(db, session, formData);
    // Blanket-invalidate the cached AppView threads so the new comment shows on
    // the next render. Alpha-scale: one shared tag across ALL photo threads, so
    // any comment busts every cached thread — acceptable churn at launch
    // traffic; per-post tagging is a future refinement. Next 16 requires the
    // cacheLife profile arg ("max" = stale-while-revalidate background refresh);
    // the author's OWN immediate view is covered separately by
    // pendingOwnComments on the page, so stale-while-revalidate is fine here.
    if (result.ok) revalidateTag("photo-threads", "max");
    return result;
  } catch (err) {
    return { ok: false, error: "something went wrong — please try again" };
  }
}

/**
 * Pure core for deleteCommentAction: no coupling to iron-session or Next
 * context. Ownership is enforced inside `deleteOwnComment` itself (the
 * `recordUri`'s repo DID must equal the session's own DID) — never trust a
 * client-supplied DID for identity, only the session.
 */
export async function deleteCommentActionCore(
  db: Db,
  session: SessionLike,
  formData: FormData,
): Promise<ActionResult> {
  if (!session.did) return { ok: false, error: "sign in to delete this comment" };

  const recordUri = String(formData.get("recordUri") ?? "");
  if (!recordUri) return { ok: false, error: "missing comment" };

  try {
    return await deleteOwnComment(db, (did) => restoreAgent(db, did), session.did, recordUri);
  } catch (err) {
    return { ok: false, error: "something went wrong — please try again" };
  }
}

export async function deleteCommentAction(formData: FormData): Promise<ActionResult> {
  try {
    const session = await getSession();
    const db = getDb();
    const result = await deleteCommentActionCore(db, session, formData);
    // Same blanket invalidation as commentAction — a deleted comment must stop
    // showing on the next render (alpha-scale one-tag-for-all churn accepted).
    if (result.ok) revalidateTag("photo-threads", "max");
    return result;
  } catch (err) {
    return { ok: false, error: "something went wrong — please try again" };
  }
}
