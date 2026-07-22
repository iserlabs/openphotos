import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { getOAuthClient, resolveHandle } from "@/lib/oauth";
import { getIronSessionData } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * OAuth redirect target. Completes the authorization code exchange, resolves the
 * authenticated DID's handle, stores both in the encrypted session cookie, then
 * sends the user on to pick their sources. `redirect()` throws NEXT_REDIRECT, so
 * every redirect here is deliberately outside a try/catch (per Next's guidance).
 */
export async function GET(req: Request) {
  const client = await getOAuthClient(getDb());
  const params = new URL(req.url).searchParams;

  let did: string | undefined;
  try {
    const { session } = await client.callback(params);
    did = session.did;
  } catch {
    did = undefined;
  }
  if (!did) redirect("/register?error=oauth");

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

  redirect("/register/sources");
}
