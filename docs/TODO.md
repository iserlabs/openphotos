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
- [x] Kevin registered; 32 photos live incl. the 10-image gallery post (criterion 1 ✓). NOTE: Bluesky's new `app.bsky.embed.gallery` embed silently bypassed the mapper — fixed with real-record fixture (9a2bdf1), indexed via re-backfill. Criterion 2 (<60s live): next fresh post is the true test — the transport was proven live (cursor tracked the event), only the mapper dropped it
- [~] Lighthouse (criterion 4): CLS 0 / TBT 0 everywhere; desktop 84, mobile ~70 — LCP is image-bytes-bound on throttled mobile. Deep fix filed below (responsive renditions)
- [x] CI migration step enabled and green (first in-CI migrate ran 2026-07-22; DATABASE_URL secret = unpooled)

## 2. Phase 2 spec — social layer (continue after launch)

- [ ] **Brainstorm + spec the social layer** (likes / comments / follows as ATProto records, notifications, engagement display). Same pipeline as Foundation: brainstorm → spec → plan → subagent execution.
  - Key open decision (Foundation spec §14): interactions via Bluesky's lexicons (max interop) vs `social.luminance.*` (portfolio-grade semantics)
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
