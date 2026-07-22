# luminance.social — Task List

_Last updated: 2026-07-21. Foundation is merged to main but nothing is deployed yet._

## 1. Alpha launch (next up)

Follow `docs/runbooks/launch-alpha.md` step by step. Summary of the sequence:

- [x] Create GitHub repo + push main — **iserlabs/luminance-social** (2026-07-22; CI green on main, Renovate auto-configured)
- [x] Neon Postgres provisioned via Vercel Marketplace (`luminance-db`, iad1, DATABASE prefix); migrations 0000+0001 applied; feed renders healthy empty state (2026-07-22). ADMIN_DIDS set to Kevin's DID (kevinleephotos.bsky.social)
- [x] Vercel project linked — **iser-labs/luminance-social**, rootDirectory `apps/web`, live at https://luminance-social.vercel.app (2026-07-22). Env set: PUBLIC_URL, SESSION_SECRET, OAUTH_JWK_1 (prod+preview). Still needed: DATABASE_URL (after DB), ADMIN_DIDS (Kevin's DID)
- [ ] Fly: `fly apps create luminance-ingestor`, set secrets, first deploy; add `FLY_API_TOKEN` to GitHub secrets
- [ ] DNS: luminance.social → Vercel
- [ ] Publish lexicons per `docs/runbooks/publish-lexicons.md` (**two** TXT records: `_lexicon.portfolio.luminance.social` and `_lexicon.actor.luminance.social`)
- [ ] OAuth smoke test with a real bsky.social account (needs the public https URL)
- [ ] Register Kevin's account; verify a Bluesky photo post appears in the feed < 60s (success criterion 2)
- [ ] Lighthouse ≥ 90 on `/` and one photo page (criterion 4)
- [ ] Enable the commented-out migration step in `.github/workflows/ci.yml` once `DATABASE_URL` exists as a repo secret

## 2. Phase 2 spec — social layer (continue after launch)

- [ ] **Brainstorm + spec the social layer** (likes / comments / follows as ATProto records, notifications, engagement display). Same pipeline as Foundation: brainstorm → spec → plan → subagent execution.
  - Key open decision (Foundation spec §14): interactions via Bluesky's lexicons (max interop) vs `social.luminance.*` (portfolio-grade semantics)
  - Prereq already in place: ingestor is a connection manager, ready for a second collection-filtered Jetstream subscription; photos use strong refs
- [ ] Then phase 3 (publisher core + tooling — klee.photos as flagship) and phase 4 (full-service onboarding: account provisioning, DNS wizard, site sync)

## 3. Deferred fast-follows (filed during Foundation review; none block launch)

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
