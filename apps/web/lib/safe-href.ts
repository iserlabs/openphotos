/**
 * Sanitizes a user-supplied URL (e.g. `photographer.website`) for use as an
 * `href`. Only `http:`/`https:` survive — this blocks `javascript:`, `data:`,
 * and other schemes that would execute or render as script when clicked.
 */
export function safeExternalHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
