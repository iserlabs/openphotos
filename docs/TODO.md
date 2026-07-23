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

- [ ] **Perf: responsive image renditions** — add a ~640px preset + srcset/sizes on grid tiles (mobile LCP is transfer-bound: 112-344KB avif at 1024px over throttled links); consider blur-up placeholders. Goal: mobile Lighthouse ≥ 90 (criterion 4)
- [ ] **Cursor-lag alert false-positives** — with a quiet single-DID filter, no events = lag grows at wall-clock rate and the >300s alert fires though nothing is wrong; distinguish "no events to consume" from "falling behind"
- [ ] **Next 16 params encoding regression test** — pages get percent-encoded params, route handlers decoded (bit us in prod: photo pages 404'd); the deferred Playwright suite must cover a photo-page navigation

- [ ] Playwright E2E suite (feed render, per-photo hide, label blur, proxy headers) — spec §13 gap, plan defect
- [ ] Jetstream skipped-event cursor gap (I6): a transiently-failed event is skipped permanently; reconnect-from-cursor on handler failure
- [ ] SIGTERM/SIGINT graceful shutdown in the ingestor (clear timers, `consumer.stop()`)
- [ ] Registry-drain edge: close the Jetstream socket when the registered-DID set drops to zero mid-connection
- [ ] Photo detail lightbox with keyboard nav (spec §10)
- [ ] DID-based permanent fallback profile route (handle changes orphan bookmarked `/[handle]` URLs)
- [ ] Backfill status + manual retry visible in `/settings` (spec §12)
- [ ] Admin audit log (actor DID + action) before multi-admin
- [ ] Run `test:integration` (SQLite-native, no infra) in CI as a merge gate or nightly
- [ ] Assorted minors: profile page load-more past 60 photos, React.cache dedup for metadata queries, purge-vs-inflight-backfill race, `getSeries` cover for Grain galleries

### Phase-2 social-layer carried minors (filed during task reviews; none block the branch merge)

- [ ] **Delete-button pending/error feedback** — the comment delete `<form>` in `apps/web/components/comment-thread.tsx` discards the action result, so a failed delete leaves the comment in place with no signal. Add a pending/error affordance.
- [ ] **Notifications-page avatar scheme check** — confirm `/notifications` runs actor avatar URLs through the same `safeExternalHref` scheme-check the comment thread uses (AppView/DB avatar URLs are untrusted input).
- [ ] **Shared photographer-lookup helper consolidation** — `isRegisteredPhotographer` / `getActivePhotographer` (`apps/web/lib/interactions.ts`) and `getPhotographerByHandle` (`apps/web/lib/queries.ts`) overlap; consolidate into one active-photographer lookup.
- [ ] **Comment/follow DB-half self-heal test parity** — `interactions.test.ts` proves the record-first / DB-half-failure `{ok:false}` path for `likePhoto`; add the equivalent coverage for `commentOnPhoto` and `followPhotographer`.

### Phase-2 final-review fast-follows (filed during the final fix wave; none block merge)

- [ ] **Expired-session re-auth UX** — a `restoreAgent` failure (revoked/expired OAuth session) currently surfaces as a generic `{ok:false}`. Detect it and route the viewer to a "session expired" state + `/login?returnTo=<current>` so they can re-auth in place instead of hitting a dead write.
- [ ] **Author-label blur union in threads** — a comment's blur-gate uses only the reply post's own labels; union in the author's account-level labels so an author-labeled account's replies blur consistently with their photos.
- [ ] **Sweep-side janitor** — periodic cleanup the sweep is well-placed to own: prune stale `interactions` follow rows (unfollows never absorbed by an engagement row), TTL-expire old `oauthStates`, and clean up `oauthSessions` on explicit signOut.
- [ ] **Avatar on write-through notifications** — like/comment/follow notifications written from `lib/interactions.ts` store `actorAvatarUrl: null` (only the sweep path snapshots avatars). Resolve and store the actor's avatar on the write-through path so the notifications list isn't avatar-less for fresh interactions.
- [ ] **Reply-to-comment UI + parent-ref validation** — the composer only posts top-level comments; add a reply affordance that threads under a parent comment, and validate the supplied parent ref (uri+cid) belongs to the same root before building the reply record.
- [ ] **429 extra backoff multiplier** — on a rate-limited sweep abort, apply an additional backoff multiplier to the next governed interval (not just the base) so a sustained 429 storm backs off faster than the plain request-count governor.
- [ ] **Viewer `/notifications` dead-end copy** — a signed-in non-photographer visiting `/notifications` is redirected to `/login`; give a clearer "notifications are for registered photographers" message instead of the login dead-end.
- [ ] **Real non-empty getLikes fixture (post-launch)** — the AppView `getLikes` fixture is currently empty; capture a real non-empty response once there's live like data to harden the like fan-out against the true wire shape.
