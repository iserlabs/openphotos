import { eq, ne, and } from "drizzle-orm";
import { photographers, type Db } from "@luminance/db";
import { resolvePdsEndpoint, safeJsonFetch } from "@luminance/atproto";

/**
 * Automatic content freshness without the firehose: the public Jetstream feed
 * has been observed starving this PDS's events for 24h+, so instead of waiting
 * on delivery we ASK each photographer's own PDS whether their repo changed —
 * `com.atproto.sync.getLatestCommit` is one tiny request returning the repo's
 * current rev. Rev moved since we last looked → re-arm that photographer's
 * reconciliation walk (backfill_status='pending'; the 10s loop does the rest).
 *
 * Cost: one request per photographer per interval, to their own PDS (not the
 * rate-budgeted AppView). Any repo write (posts, but also likes/follows) moves
 * the rev, so some probes re-arm for non-photo activity — the walk is cheap
 * and idempotent, so that's accepted noise.
 *
 * State is in-memory: after a deploy the first probe cycle just re-primes
 * baselines (no spurious walks); anything missed during the window is covered
 * by the periodic reconcile.
 */
export function createFreshnessProbe(db: Db, opts: {
  fetchJson?: (url: string) => Promise<unknown>;
  resolvePds?: (did: string) => Promise<string>;
  intervalMs?: number;
} = {}) {
  const fetchJson = opts.fetchJson ?? safeJsonFetch;
  const resolvePds = opts.resolvePds ?? resolvePdsEndpoint;
  const intervalMs = opts.intervalMs ?? 45_000;
  const lastRev = new Map<string, string>();
  const pdsCache = new Map<string, { endpoint: string; at: number }>();
  const PDS_TTL_MS = 60 * 60 * 1000;
  let lastChangeAt: number | null = null;

  async function probeOnce(): Promise<void> {
    const active = await db
      .select({ did: photographers.did, backfillStatus: photographers.backfillStatus })
      .from(photographers)
      .where(and(eq(photographers.status, "active"), ne(photographers.backfillStatus, "running")));
    for (const p of active) {
      try {
        let pds = pdsCache.get(p.did);
        if (!pds || Date.now() - pds.at > PDS_TTL_MS) {
          pds = { endpoint: await resolvePds(p.did), at: Date.now() };
          pdsCache.set(p.did, pds);
        }
        const res = (await fetchJson(
          `${pds.endpoint}/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(p.did)}`,
        )) as { rev?: string };
        if (typeof res?.rev !== "string" || !res.rev) continue;
        const prev = lastRev.get(p.did);
        lastRev.set(p.did, res.rev);
        if (prev !== undefined && prev !== res.rev) {
          lastChangeAt = Date.now(); // PDS-truth activity signal (cursor-lag alert gating)
          if (p.backfillStatus !== "pending") {
            await db.update(photographers).set({ backfillStatus: "pending" }).where(eq(photographers.did, p.did));
          }
        }
      } catch (err) {
        // Best-effort per photographer — a flaky PDS must not stop the probe.
        console.error("freshness probe: skipped", { did: p.did, err: String(err) });
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    probeOnce,
    /** When any watched repo's rev last changed (null = none observed yet).
     * The cursor-lag monitor uses this to distinguish "the filter is quiet"
     * (no repo activity — lag growing is normal) from "events exist upstream
     * but aren't reaching us" (alert-worthy starvation). */
    lastRevChangeAt: () => lastChangeAt,
    start() {
      timer = setInterval(() => {
        void probeOnce().catch((err) => console.error("freshness probe: tick failed", err));
      }, intervalMs);
      return timer;
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
