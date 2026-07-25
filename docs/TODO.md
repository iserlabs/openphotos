# luminance.social — Task List

_Last updated: 2026-07-21. Foundation is merged to main but nothing is deployed yet._

## 1. Alpha launch (next up)

Follow `docs/runbooks/launch-alpha.md` step by step. Summary of the sequence:

- [x] Create GitHub repo + push main — **iserlabs/luminance-social** (2026-07-22; CI green on main, Renovate auto-configured)
- [x] Neon Postgres provisioned via Vercel Marketplace (`luminance-db`, iad1, DATABASE prefix); migrations 0000+0001 applied; feed renders healthy empty state (2026-07-22). ADMIN_DIDS set to Kevin's DID (kevinleephotos.bsky.social)
- [x] Vercel project linked — **iser-labs/luminance-social**, rootDirectory `apps/web`, live at https://luminance-social.vercel.app (2026-07-22). Env set: PUBLIC_URL, SESSION_SECRET, OAUTH_JWK_1 (prod+preview). Still needed: DATABASE_URL (after DB), ADMIN_DIDS (Kevin's DID)
- [x] Fly: `luminance-ingestor` live in iad (personal org — no iserlabs Fly org exists; transferable later), scaled to 1 machine, health passing, DATABASE_URL (unpooled) secret set; FLY_API_TOKEN in GitHub secrets for auto-deploy (2026-07-22). Note: always-on ingestor keeps Neon compute awake — free tier is 100 CU-hrs/mo, expect to outgrow it in ~2 weeks
- [x] DNS: luminance.social → Vercel via Cloudflare (A @ 216.150.1.1 + CNAME www, both DNS-only/grey-cloud; cert issued via `vercel certs issue`; PUBLIC_URL flipped to https://luminance.social; OAuth metadata verified on the real domain) (2026-07-22)
- [x] Lexicon authority TXT records live: `_lexicon.actor` + `_lexicon.portfolio` → did=did:plc:ka5oytd2d6rhs2r6yrvt6yb2 (Kevin's account is the authority)
- [x] Lexicons published via goat (all three 🟢, end-to-end resolution verified with `goat lex resolve`) (2026-07-22)
- [x] OAuth smoke test passed — Kevin registered via the live DPoP flow (2026-07-22)
- [x] Kevin registered; index converges with his repo (22 photos incl. the new 10-image gallery; deleted posts removed). Two incidents diagnosed + fixed on launch day:
  1. Bluesky's new `app.bsky.embed.gallery` embed bypassed the mapper — fixed with a real-record fixture (9a2bdf1)
  2. **Jetstream upstream lag**: Bluesky's own AppView indexed Kevin's post in 52s, but the event never reached the public Jetstream instances (verified by unfiltered stream scan) — his PDS's events reach Jetstream 30+ min late or not at all. OUR transport was correct. Mitigation shipped: PDS-truth reconciliation (backfill diff-deletes vanished records, 54aaa8f) + hourly automatic re-reconcile (9cc19ea). Staleness now bounded at ~1h worst-case regardless of firehose health; <60s (criterion 2) holds whenever upstream is healthy — re-verify on a healthy day with a fresh post
- [~] Lighthouse (criterion 4): CLS 0 / TBT 0 everywhere; desktop 84, mobile ~70 — LCP is image-bytes-bound on throttled mobile. Deep fix filed below (responsive renditions)
- [x] CI migration step enabled and green (first in-CI migrate ran 2026-07-22; DATABASE_URL secret = unpooled)

## 2. Phase 2 spec — social layer (continue after launch)

- [x] **Brainstorm + spec the social layer** (likes / comments / follows as ATProto records, notifications, engagement display) — specced (`docs/superpowers/specs/2026-07-22-social-layer-design.md`), planned, and built on `feature/social-layer` (2026-07-23). **Decision resolved: Bluesky's own lexicons** (`app.bsky.feed.like` / `app.bsky.feed.post` replies / `app.bsky.graph.follow`) for maximum interop — viewer likes/comments/follows land as real records in the viewer's repo and reach the photographer's Bluesky notifications. Shipped: interaction service (write-through rows + notifications + engagement deltas), notifications center, engagement sweep, and a dev-env write-path integration test (`apps/web/integration/social.dev-env.test.ts`).
  - Key open decision (Foundation spec §14): interactions via Bluesky's lexicons (max interop) vs `social.luminance.*` (portfolio-grade semantics) — **chose Bluesky lexicons**; `social.luminance.*` interactions deferred to phase 3 (router branch stubbed, spec §10)
  - Prereq already in place: ingestor is a connection manager, ready for a second collection-filtered Jetstream subscription; photos use strong refs
- [ ] Then phase 3 (publisher core + tooling — klee.photos as flagship) and phase 4 (full-service onboarding: account provisioning, DNS wizard, site sync)

## 3. Deferred fast-follows (filed during Foundation review; none block launch)
- [x] **"Refresh my photos" button in /settings** (shipped 2026-07-23; now a fallback — the freshness probe makes indexing automatic) — photographer-initiated re-arm (sets backfill_status=pending); gives sub-minute freshness for own posts without waiting for the 15-min reconcile while Jetstream keeps starving this PDS
- [x] **Freshness probe verified end-to-end** (2026-07-25) — Kevin's 2026-07-23 17:59Z gallery post (3mrdg3imvg22p) was indexed and live on the production feed automatically, no manual refresh; probe polls each photographer's own PDS `getLatestCommit` every 45s


- [x] **Perf: responsive image renditions + blur-up** (shipped 2026-07-25) — srcset grid+detail; 768px `grid` preset (high-DPR phones no longer forced onto the 1024px file); blur-up placeholders (16px webp data URIs generated by the image proxy on first decode, stored in `photos.blur_data_url`, painted as CSS background); eager+`fetchpriority=high` for the first two tiles (mobile LCP was a lazy image); lighter thumb/grid encodes (avif q60); warm loop re-touches freshest 60 every cycle (Vercel purges edge cache per deploy). **Results: desktop 100 (was 84); mobile FCP 1.0s / CLS 0 / TBT ≤20ms / SI 3.5s, score 80-89 across runs (was 66-70)** — filmstrip shows full visual completeness ~3s on throttled slow-4G
- [~] **Mobile LCP attribution vs CSS columns** — surgical fix shipped 2026-07-25: mobile (1-col) now renders plain block flow instead of `columns-1`, escaping the multicol fragmentation context entirely where the paint-attribution lag lived; ≥sm keeps the columns aesthetic (desktop scores 100 regardless). Re-measure mobile after deploy; the full row-major grid-masonry rewrite stays a future option if variance persists (would also fix the column-major feed-order quirk on desktop)
- [x] **Cursor-lag alert false-positives** (2026-07-25) — alert now requires a real signal: socket unhealthy (ws ping/pong) OR PDS-truth starvation (freshness probe saw a rev change newer than the cursor); healthy+quiet logs `cursor_lag_quiet_filter=1` instead
- [x] **Next 16 params encoding regression test** (2026-07-25) — `e2e/feed-and-images.spec.ts` navigates directly to a percent-encoded photo URL and asserts 200 + rendered figure
- [x] Playwright E2E suite (2026-07-25) — feed render + srcset, params regression, proxy header checks (immutable + Vary, 404 negative cache), label-blur reveal (self-skips without labeled data); runs nightly against production (`.github/workflows/nightly.yml`). Per-photo hide intentionally NOT here (needs real OAuth+DPoP session) — covered by unit + dev-env layers
- [x] Jetstream skipped-event cursor gap I6 (2026-07-25) — handler failure suspends the pipeline + reconnects from the un-advanced cursor (replay); a poison event is loudly skipped after 3 replays; `greatest()` guard keeps stale queued events from moving the cursor backwards
- [x] SIGTERM/SIGINT graceful shutdown (2026-07-25) — clears all timers, stops probe/sweep, drains the consumer queue; 10s force-exit backstop
- [x] Registry-drain edge (2026-07-25) — socket closed when the DID set drops to zero (never an empty-wantedDids options_update = whole firehose)
- [x] Photo detail lightbox with keyboard nav (2026-07-25) — Esc/←/→, scroll lock, multi-image counter
- [x] DID-based permanent fallback profile route (2026-07-25) — `/did:plc:…` redirects to the current handle's profile
- [x] Backfill status + manual retry visible in `/settings` (2026-07-25) — failed-refresh callout + retry button
- [x] Admin audit log (2026-07-25) — `admin_audit` table (migration 0005), written by the takedown action
- [x] Run `test:integration` in CI (2026-07-25) — nightly workflow (with workflow_dispatch), alongside the prod E2E job
- [x] Assorted minors (2026-07-25): profile load-more (cursor pagination), React.cache dedup for photo+profile metadata queries, purge-vs-inflight-backfill race guard (per-collection status re-check), series cover fallback to first item (Grain galleries)

### Phase-2 social-layer carried minors (filed during task reviews; none block the branch merge)

- [x] **Delete-button pending/error feedback** (2026-07-25) — `DeleteCommentButton` client component with Deleting…/error states
- [x] **Notifications-page avatar scheme check** (2026-07-25) — was indeed missing; now through `safeExternalHref`
- [x] **Shared photographer-lookup helper consolidation** (2026-07-25) — `getActivePhotographer` is the single active-lookup (boolean twin removed); `getPhotographerByDid` added for the DID route
- [x] **Comment/follow DB-half self-heal test parity** (2026-07-25) — both paths now covered

### Phase-2 final-review fast-follows (filed during the final fix wave; none block merge)

- [x] **Expired-session re-auth UX** (2026-07-25) — `SESSION_EXPIRED_ERROR` sentinel from the service; like/comment/delete/follow client components route to `/login?returnTo=<current>`
- [x] **Author-label blur union in threads** (2026-07-25) — reply labels ∪ author account labels
- [x] **Sweep-side janitor** (2026-07-25) — 24h prune of soft-deleted follow rows, 1h `oauthStates` TTL, `oauth_sessions` row deleted on explicit signOut
- [x] **Avatar on write-through notifications** (2026-07-25) — best-effort AppView `getProfile` snapshot, injected as `resolveAvatar` (null on failure; never blocks the interaction)
- [x] **Reply-to-comment UI + parent-ref validation** (2026-07-25) — per-node Reply toggle + inline composer; server verifies the parent's cid AND that its thread root is this photo's post before creating the record
- [x] **429 extra backoff multiplier** (2026-07-25) — doubles per consecutive rate-limited sweep (cap 8×), resets on the first clean sweep
- [x] **Viewer `/notifications` dead-end copy** (2026-07-25) — clear "notifications are for registered photographers" page with a register link
- [ ] **Real non-empty getLikes fixture (still blocked)** — checked 2026-07-25: zero likes exist on any live post yet; capture the real wire shape once first likes land
