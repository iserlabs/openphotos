"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { oauthSessions } from "@openphotos/db";
import { getDb } from "@/lib/db";
import { getIronSessionData } from "@/lib/session";

/**
 * Header-level sign out, for both photographer and viewer sessions. Lives at
 * the app root (rather than under a single route's `actions.ts`) since the
 * header in `app/layout.tsx` renders on every page. `destroy()` clears the
 * session data and expires the cookie synchronously — no `save()` needed
 * afterward. `redirect()` is called outside any try/catch by design.
 *
 * Also deletes the persisted OAuth session row (sweep-janitor fast-follow):
 * an explicit sign-out means the stored tokens should not linger. Best-effort
 * — a DB blip must never block signing out of the cookie session.
 */
export async function signOut() {
  const session = await getIronSessionData();
  const did = session.did;
  if (did) {
    try {
      await getDb().delete(oauthSessions).where(eq(oauthSessions.key, did));
    } catch {
      // cookie session still clears; the row is orphaned until next sign-in overwrites it
    }
  }
  session.destroy();
  redirect("/");
}
