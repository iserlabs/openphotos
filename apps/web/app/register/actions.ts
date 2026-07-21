"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { getOAuthClient, resolveHandle } from "@/lib/oauth";
import { getSession, getIronSessionData } from "@/lib/session";
import { completeRegistration } from "@/lib/registration";

/**
 * Step 1 of registration: take the handle the user typed and kick off ATProto
 * OAuth. `client.authorize` performs PAR + builds the PDS authorization URL; we
 * redirect the browser there. redirect() is called outside try/catch by design.
 */
export async function startLogin(formData: FormData) {
  const handle = String(formData.get("handle") ?? "").trim();
  if (!handle) redirect("/register?error=handle");

  const client = await getOAuthClient(getDb());
  let url: URL | undefined;
  try {
    url = await client.authorize(handle);
  } catch {
    url = undefined;
  }
  if (!url) redirect("/register?error=login");
  redirect(url.toString());
}

/**
 * Step 2: persist the chosen sources. Identity comes from the session (never the
 * form), so the client can only pick toggles — not whose account is registered.
 * Writes an active photographer with a pending backfill, which the ingestor's
 * poll then picks up.
 */
export async function saveSources(formData: FormData) {
  const session = await getSession();
  if (!session.did) redirect("/register?error=session");

  const db = getDb();
  let handle = session.handle;
  if (!handle) {
    try {
      handle = await resolveHandle(session.did);
    } catch {
      handle = undefined;
    }
  }
  if (!handle) redirect("/register?error=handle");

  const includeBsky = formData.get("includeBsky") != null;
  const includeGrain = formData.get("includeGrain") != null;
  await completeRegistration(db, { did: session.did, handle, includeBsky, includeGrain });

  // Cache the resolved handle for the status page's profile link.
  if (session.handle !== handle) {
    const s = await getIronSessionData();
    s.handle = handle;
    await s.save();
  }

  redirect("/register/status");
}
