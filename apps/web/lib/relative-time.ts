const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Coarse "time ago" for notification rows: sub-minute reads as "now",
 * otherwise the largest whole unit that fits ("5m", "3h", "2d" — never
 * combined, e.g. never "1d 2h"). `now` is injectable so tests are
 * deterministic; production callers omit it and get the real clock.
 */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  if (diffMs < MINUTE_MS) return "now";
  if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}m`;
  if (diffMs < DAY_MS) return `${Math.floor(diffMs / HOUR_MS)}h`;
  return `${Math.floor(diffMs / DAY_MS)}d`;
}
