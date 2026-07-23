import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { getOAuthClient, resolveHandle } from "@/lib/oauth";
import { decodeAppState } from "@/lib/oauth-state";
import { getIronSessionData } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * OAuth redirect target, shared by the `/register` and `/login` (viewer)
 * flows. Completes the authorization code exchange, resolves the
 * authenticated DID's handle, and stores both in the encrypted session
 * cookie. From there it forks on the app state that rode along in
 * `client.callback()`'s `state` field (see VERIFY-API note in lib/oauth.ts):
 * `mode=register` continues to `/register/sources` unchanged;
 * `mode=viewer` sends the visitor back to `returnTo` (or `/`). Absent or
 * undecodable state — e.g. a stale in-flight request from before this
 * fork existed — defaults to the original `register` behavior.
 * `redirect()` throws NEXT_REDIRECT, so every redirect here is deliberately
 * outside a try/catch (per Next's guidance).
 */
export async function GET(req: Request) {
  const client = await getOAuthClient(getDb());
  const params = new URL(req.url).searchParams;

  let did: string | undefined;
  let rawState: string | null = null;
  try {
    const { session, state } = await client.callback(params);
    did = session.did;
    rawState = state;
  } catch {
    did = undefined;
  }

  const appState = decodeAppState(rawState);
  const mode = appState?.mode ?? "register";

  if (!did) redirect(mode === "viewer" ? "/login?error=oauth" : "/register?error=oauth");

  // Best-effort handle resolution; if it fails now, saveSources re-resolves it.
  let handle: string | undefined;
  try {
    handle = await resolveHandle(did);
  } catch {
    handle = undefined;
  }

  const session = await getIronSessionData();
  session.did = did;
  session.handle = handle;
  await session.save();

  if (mode === "viewer") redirect(appState?.returnTo ?? "/");
  redirect("/register/sources");
}
