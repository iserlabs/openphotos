"use server";

import type { Db } from "@luminance/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { followPhotographer, unfollowPhotographer, restoreAgent, RateLimitError } from "@/lib/interactions";

type ActionResult = { ok: true } | { ok: false; error: string };

type SessionLike = { did?: string; handle?: string };

/**
 * Pure core for followAction: no coupling to iron-session or Next context.
 * The photographer's did+handle come from the form (the profile page the
 * viewer is on); the actor's identity (did, handle) is ALWAYS the session —
 * never trust a client-supplied did for who is doing the following.
 */
export async function followActionCore(
  db: Db,
  session: SessionLike,
  formData: FormData,
): Promise<ActionResult> {
  if (!session.did) return { ok: false, error: "sign in to follow this photographer" };

  const photographerDid = String(formData.get("photographerDid") ?? "");
  const photographerHandle = String(formData.get("photographerHandle") ?? "");
  if (!photographerDid || !photographerHandle) return { ok: false, error: "missing photographer" };

  try {
    return await followPhotographer(db, (did) => restoreAgent(db, did), session.did, session.handle ?? session.did, {
      photographerDid,
      photographerHandle,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return { ok: false, error: "Slow down — you're interacting a lot right now." };
    return { ok: false, error: "something went wrong — please try again" };
  }
}

/**
 * Server action for a profile page's follow button. Session-checked,
 * dispatches to `followPhotographer`, and translates every failure mode —
 * including a rate-limit rejection — into `{ok:false, error}`. Entire body
 * wrapped in try/catch so getSession()/getDb() failures never escape uncaught.
 */
export async function followAction(formData: FormData): Promise<ActionResult> {
  try {
    const session = await getSession();
    const db = getDb();
    return await followActionCore(db, session, formData);
  } catch (err) {
    return { ok: false, error: "something went wrong — please try again" };
  }
}

/**
 * Pure core for unfollowAction: no coupling to iron-session or Next context.
 */
export async function unfollowActionCore(
  db: Db,
  session: SessionLike,
  formData: FormData,
): Promise<ActionResult> {
  if (!session.did) return { ok: false, error: "sign in to unfollow this photographer" };

  const photographerDid = String(formData.get("photographerDid") ?? "");
  if (!photographerDid) return { ok: false, error: "missing photographer" };

  try {
    return await unfollowPhotographer(db, (did) => restoreAgent(db, did), session.did, photographerDid);
  } catch (err) {
    if (err instanceof RateLimitError) return { ok: false, error: "Slow down — you're interacting a lot right now." };
    return { ok: false, error: "something went wrong — please try again" };
  }
}

export async function unfollowAction(formData: FormData): Promise<ActionResult> {
  try {
    const session = await getSession();
    const db = getDb();
    return await unfollowActionCore(db, session, formData);
  } catch (err) {
    return { ok: false, error: "something went wrong — please try again" };
  }
}
