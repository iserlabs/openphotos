/**
 * Seconds between "now" and the Jetstream event most recently applied to the
 * ingest cursor. `timeUs` is microseconds since epoch (Jetstream's
 * `time_us`), `nowMs` is milliseconds since epoch (`Date.now()`). Pulled out
 * as a pure function so the lag/threshold math is unit-testable without a DB.
 */
export function cursorLagSeconds(timeUs: bigint, nowMs: number): number {
  return (nowMs * 1000 - Number(timeUs)) / 1e6;
}
