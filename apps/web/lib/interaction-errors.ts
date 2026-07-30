/**
 * Sentinel error string for an expired/revoked OAuth session, shared between
 * the interaction service (server) and the client components that render
 * action results. Client components compare `result.error` against this and
 * route the viewer to `/login?returnTo=…` instead of showing a dead generic
 * error. Kept in its own file (no server-only imports) so client bundles can
 * import it safely.
 */
export const SESSION_EXPIRED_ERROR = "session-expired";

/** The re-auth destination for an expired session, preserving return routing. */
export function loginHref(returnTo: string): string {
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}
