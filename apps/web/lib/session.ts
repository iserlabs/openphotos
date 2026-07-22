import { getIronSession, type IronSession } from "iron-session";
import { env } from "./env";

/**
 * Encrypted-cookie session payload. We only ever persist the authenticated DID
 * (the identity) plus the resolved handle (a display/registration convenience).
 * `next/headers` is imported lazily inside {@link getIronSessionData} so this
 * module stays importable outside a Next request context (e.g. unit tests).
 */
export type SessionData = { did?: string; handle?: string };

const SESSION_COOKIE = "luminance_session";

/**
 * Pure admin rule: a session is admin iff it carries a DID that appears in the
 * configured ADMIN_DIDS allow-list. Extracted so it can be unit-tested without
 * standing up a request-scoped cookie store.
 */
export function isAdminDid(did: string | undefined, adminDids: string[]): boolean {
  return did != null && adminDids.includes(did);
}

/**
 * The mutable iron-session handle (has `.save()`/`.destroy()`), for routes and
 * server actions that need to set or clear the cookie. Reads env lazily.
 */
export async function getIronSessionData(): Promise<IronSession<SessionData>> {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, {
    cookieName: SESSION_COOKIE,
    password: env.SESSION_SECRET,
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      // Secure cookies over HTTPS; relaxed on http://localhost for dev.
      secure: env.PUBLIC_URL.startsWith("https://"),
      path: "/",
    },
  });
}

/**
 * Read-only view of the current session for pages/actions: the DID + handle plus
 * the derived `isAdmin` flag. Satisfies the Task 13 contract
 * `{ did?: string; isAdmin: boolean }` (handle is an additive convenience).
 */
export async function getSession(): Promise<{ did?: string; handle?: string; isAdmin: boolean }> {
  const s = await getIronSessionData();
  return { did: s.did, handle: s.handle, isAdmin: isAdminDid(s.did, env.ADMIN_DIDS) };
}
