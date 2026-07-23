"use server";

import { redirect } from "next/navigation";
import { getIronSessionData } from "@/lib/session";

/**
 * Header-level sign out, for both photographer and viewer sessions. Lives at
 * the app root (rather than under a single route's `actions.ts`) since the
 * header in `app/layout.tsx` renders on every page. `destroy()` clears the
 * session data and expires the cookie synchronously — no `save()` needed
 * afterward. `redirect()` is called outside any try/catch by design.
 */
export async function signOut() {
  const session = await getIronSessionData();
  session.destroy();
  redirect("/");
}
