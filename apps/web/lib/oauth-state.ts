/**
 * "App state" carried through an OAuth authorize/callback round-trip: why we
 * sent the visitor to their PDS to sign in, and where to send them once
 * they're back. See the VERIFY-API note above `authorizeWithState` in
 * `./oauth.ts` for how this string travels through
 * `@atproto/oauth-client`'s own `state` parameter — no new table or cookie.
 */
export type AppState = { mode: "viewer" | "register"; returnTo?: string };

/**
 * Validates a post-login redirect target. Only a single-leading-slash
 * relative path survives: this rejects protocol-relative URLs (`//evil.com`),
 * the backslash variant some browsers also treat as protocol-relative
 * (`/\evil.com`), any absolute URL (which necessarily lacks the leading `/`,
 * ruling out `https:`, `javascript:`, etc.), and control characters a
 * browser might strip while resolving the URL. Returns the value unchanged
 * when safe, `undefined` otherwise.
 */
export function sanitizeReturnTo(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith("/")) return undefined;
  if (value.startsWith("//")) return undefined;
  if (value.startsWith("/\\")) return undefined;
  if (/[\x00-\x1f\x7f]/.test(value)) return undefined;
  return value;
}

/**
 * Serializes {@link AppState} to hand to `authorize()`'s `state` option.
 * `returnTo` is validated here too (never trust the caller already did) and
 * silently dropped — not the whole encode — if it's unsafe.
 */
export function encodeAppState(state: AppState): string {
  const returnTo = sanitizeReturnTo(state.returnTo);
  return JSON.stringify(returnTo ? { mode: state.mode, returnTo } : { mode: state.mode });
}

/**
 * Parses the string handed back as `state` from `client.callback()`.
 * Returns `undefined` for anything malformed: not JSON, not an object, or
 * missing a recognized `mode`. An unsafe `returnTo` is dropped rather than
 * invalidating the whole state, since `mode` alone is still trustworthy.
 */
export function decodeAppState(raw: string | null | undefined): AppState | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const { mode, returnTo } = parsed as Record<string, unknown>;
  if (mode !== "viewer" && mode !== "register") return undefined;

  const safeReturnTo = typeof returnTo === "string" ? sanitizeReturnTo(returnTo) : undefined;
  return safeReturnTo ? { mode, returnTo: safeReturnTo } : { mode };
}
