# Luminance.social — Foundation Design (Sub-project 1 of 4)

**Date:** 2026-07-21
**Status:** Draft for review
**Scope of this spec:** Sub-project 1 ("Foundation") of the luminance.social platform. Product-level decisions and the full decomposition are recorded here as context; only the Foundation is designed to implementation depth.

---

## 1. Product vision

Luminance.social is a photography aggregation hub built on ATProto. Photographers keep their own portfolio websites (e.g. klee.photos, cederikleeuwe.com, ayyynabudaeva.com); their photos are published as records in their own ATProto data repositories (PDSes); luminance.social is an AppView that indexes registered photographers' photo records and displays them in one social hub. The portfolio site is the publisher; the hub is the aggregator. Photographers own their data at the protocol level.

## 2. Competitive landscape (as of 2026-07)

- **Grain (grain.social)** — closest competitor. Photography community on ATProto with its own lexicons (`social.grain.*`), galleries, comments, follows. Destination-app model: you post *into* Grain. No portfolio-site syndication, no domain-identity story.
- **Flashes / Pinksky** — Instagram-style Bluesky clients over `app.bsky.feed.post`. Views over Bluesky, not portfolio systems.
- **standard.site / WhiteWind / Leaflet** — validate the exact "your site publishes to your PDS, apps aggregate" model, but for *blogging*. Nobody has ported it to photography.
- **Pixelfed / Glass / Behance / Format** — non-ATProto adjacents; either federated destination apps or centralized communities.

**The niche is open.** Main competitive risks: Grain expanding sideways into syndication; someone cloning standard.site's playbook for photos. Mitigation: move quickly; design for ecosystem compatibility (we index Grain records rather than compete with them for data).

## 3. Product decisions (locked)

| Decision | Choice |
|---|---|
| Lexicon strategy | **Hybrid** — publish our own `social.luminance.*` portfolio lexicon AND index existing photo content (Bluesky image posts, Grain records) |
| Who appears in the hub | **Opt-in only** — registered photographers exclusively |
| Onboarding ambition (v1 launch) | **Full-service** — Luminance can create the ATProto account, walk through DNS, and sync a hosted portfolio site |
| Social features (v1 launch) | **ATProto-native interactions** — likes/comments/follows written as ATProto records |
| Hosting architecture | **Vercel app + dedicated ingest worker** (Fly.io) with Neon Postgres |

## 4. Decomposition — build order vs. launch order

Four sub-projects, each with its own spec → plan → implementation cycle:

1. **Foundation** (this spec) — lexicon, AppView ingestion, image pipeline, hub site, OAuth registration, minimal takedown path.
2. **Social layer** — native likes/comments/follows as ATProto records, notifications, engagement display. Builds on 1.
3. **Publisher core + tooling** — shared library that uploads blobs and writes Luminance records to any PDS (EXIF policy incl. GPS-scrubbing by default); CLI/SDK/build-step integration for custom sites (klee.photos as flagship); web uploader. Dependency of 4, so it builds first.
4. **Full-service onboarding** — account provisioning (own-PDS vs. Bluesky-signup decision lives here), DNS wizard, site-sync service for hosted portfolios (consumes 3's publisher core).

**Launch order is explicit:** phases 1–2 support a **private alpha** limited to photographers who already have ATProto/Bluesky accounts (their existing Bluesky/Grain photos seed content — this carries only as far as the network's existing ATProto activity). **Public launch is after phase 4**, when a photographer with no ATProto presence can onboard end-to-end.

## 5. Foundation scope

**In scope:** `social.luminance.*` lexicon (published per ATProto lexicon-publishing convention); ingestion (backfill + live Jetstream subscription); unified photo index across three source lexicons; image proxy/CDN pipeline; hub site (feed, profiles, series, photo pages); OAuth registration with an existing ATProto account; per-source and per-photo curation; label handling; takedown path; observability.

**Out of scope (deferred to later sub-projects):** any write path to PDSes (publishing, interactions), account provisioning, DNS wizard, site sync, notifications, algorithmic feeds, viewer accounts.

## 6. System architecture

```
                    ┌─────────────────────────────────────────┐
                    │ Photographers' PDSes (bsky.social, etc.) │
                    └──────┬──────────────────────┬───────────┘
                           │ Jetstream firehose   │ blobs (getBlob)
                           ▼                      ▼
   Fly.io ──▶ ┌──────────────────┐      ┌──────────────────┐
              │ apps/ingestor     │      │ /img proxy route  │ ◀── Vercel CDN cache
              │ live sub+backfill │      │ fetch→resize→cache│
              └────────┬─────────┘      └────────▲─────────┘
                       │ upserts/deletes          │
                       ▼                          │
              ┌──────────────────┐      ┌────────┴─────────┐
              │ Neon Postgres     │◀────▶│ apps/web (Vercel) │
              │ (Drizzle)         │      │ Next.js 16 hub    │
              └──────────────────┘      └──────────────────┘
```

**Turbo monorepo (pnpm):**

- `apps/web` — Next.js 16 App Router on Vercel: feed, profiles, photo pages, registration/OAuth, image proxy route.
- `apps/ingestor` — Node container on Fly.io: Jetstream connection manager + backfill job runner.
- `packages/lexicons` — lexicon JSON + types generated with `@atproto/lex-cli`.
- `packages/atproto` — DID/handle resolution, OAuth client config, record mappers (three source shapes → one indexed `Photo`).
- `packages/db` — Drizzle schema + client (Neon Postgres).

**Ingestor is a connection manager**, not a single socket: v1 runs one Jetstream subscription (collection- and DID-filtered). Jetstream filters apply connection-wide, so phase 2's network-wide interaction indexing will add a second, collection-filtered connection rather than restructuring. The 10k `wantedDids` ceiling is distant; if reached, DIDs shard across connections.

**AppView contract:** the index is a disposable cache of PDS truth. Index tables can be truncated and rebuilt by re-running backfill for every registered DID. Durable app state (registration, curation, OAuth) is segregated (§8) and backed up via Neon point-in-time recovery.

## 7. Lexicon: `social.luminance.*`

NSID authority = luminance.social domain (DNS-verified); schemas also published as `com.atproto.lexicon.schema` records.

**`social.luminance.portfolio.photo`** — one photograph:
- `image` (blob; `maxSize` set within common PDS defaults — the effective ceiling is host-PDS policy, not ours)
- `aspectRatio` {width, height} — UI reserves layout before pixels arrive
- `alt` (strongly encouraged), `title`, `caption`
- `capturedAt`, `createdAt`
- `exif` — whitelisted fields only: camera, lens, focalLength, fNumber, shutterSpeed, iso. **No GPS fields exist in the schema** — location leakage is impossible by design.
- `tags[]` (genres), `license` (default all-rights-reserved)
- `selfLabels` — standard self-label union (same pattern as `app.bsky.feed.post`), for nudity/adult-work labeling

**`social.luminance.portfolio.series`** — `title`, `description`, ordered array of photo strong-refs, `coverPhoto`. Ordering lives on the series record (simpler than join records; hundreds of refs fit record limits comfortably).

**`social.luminance.actor.profile`** — `displayName`, `bio`, `websiteUrl`, `location`, `avatar`, `disciplines[]`.

Photos are referenced by strong ref (`uri` + `cid`) so phase-2 interactions use standard subject semantics — nothing to retrofit.

**Indexed source lexicons (read-only — we never write anyone else's lexicon):**
- `social.luminance.*` (above)
- `app.bsky.feed.post` — top-level posts with image embeds only; replies skipped (conversation, not portfolio); quote-posts-with-media skipped in v1; one photo row per embedded image sharing a `group_key`
- `social.grain.*` — photos + gallery membership → photos + series
- `app.bsky.actor.profile` — profile fallback (precedence: Luminance profile → Bluesky profile → bare handle)

## 8. Data model

Two categories, and the distinction is load-bearing:

**Index tables (truncate-and-rebuild safe):**
- `photos` — `at_uri` PK, `did`, `source` (`luminance|bsky|grain`), `record_cid`, `blob_cid`, `width`, `height`, `alt`, `title`, `caption`, `captured_at`, `created_at`, `sort_at`, `exif` JSONB, `tags[]`, `license`, `labels[]`, `group_key`, `indexed_at`.
- `series`, `series_photos` (`series_uri`, `photo_uri`, `position`).

**Durable app-state tables (backed up; survive index rebuilds):**
- `photographers` — `did` PK, `handle`, `display_name`, `avatar_cid`, `bio`, `website`, `status` (`active | pending_review | deactivated | deregistered | takedown`), `include_bsky`, `include_grain` (source toggles), `registered_at`, `backfill_status`.
- `photo_overrides` — `at_uri` PK, `hidden` (photographer curation), `takedown` (admin/DMCA), reason, timestamps. Kept out of `photos` precisely so index rebuilds cannot erase curation or takedowns.
- `oauth_sessions`, `oauth_states` — persistence stores required by `@atproto/oauth-client-node`.
- `ingest_cursors` — per-connection `time_us` checkpoint. (Not rebuild-relevant but operationally durable.)

`sort_at` = coalesce(capturedAt, createdAt) **clamped to `indexed_at` + small skew** — client-supplied timestamps cannot pin a photo atop the feed (same defense Bluesky uses).

Feed query: keyset pagination on `(sort_at, at_uri)`, filtered by no-override-hidden, no-takedown, photographer active; partial indexes match that exact predicate.

## 9. Ingestion

**Live path:** Jetstream subscription, `wantedCollections` = the four source families, `wantedDids` = registered photographers. The ingestor polls the registry (~30s) and pushes `options_update` down the socket on change — no reconnect. Commit events → mapper → idempotent upsert keyed by AT-URI. Deletes remove rows + series-join cleanup. `identity` events refresh stored handles (index is DID-keyed; handle changes are cosmetic). `account` events (deactivated/taken-down) hide the photographer's content immediately.

**Backfill path:** on registration (and on re-enabling a source toggle), a job walks the DID's repo per collection via paginated `listRecords` through the same mappers. Per-collection cursors make jobs resumable; throttling respects PDS rate limits; a per-collection recent-N-thousand cap prevents a 200k-record account from wedging the queue.

**The delete-vs-backfill race is real and handled:** a delete event arriving while backfill runs writes a short-lived **tombstone**; backfill upserts skip tombstoned URIs; tombstones are pruned when the backfill completes. (Create/update races are benign via idempotent upserts.)

**Cursor discipline:** the cursor advances only after a batch commits — DB outage pauses ingestion with no data loss. Reconnects resume with replay overlap (harmless). A cursor older than Jetstream's replay window is detected and triggers a reconciliation backfill of all registered DIDs — cheap because the index is rebuildable.

**Toggle semantics:** `include_bsky` off → that source's rows deleted; back on → scoped backfill.

## 10. Hub surface

**Routes** (invariant: all app routes are dotless path segments; every valid ATProto handle contains a dot, so `/[handle]` can never collide — this is a stated rule for future routes, not a coincidence):

- `/` — feed. Justified-row grid preserving aspect ratios (zero layout shift via `aspectRatio`), keyset-paginated infinite scroll, discipline/tag filter chips. Reverse-chronological only in v1. Labeled content renders blurred with click-through.
- `/[handle]` — photographer profile: avatar, bio, location, prominent link out to their portfolio site, photo grid + series shelf. DID-based route is the permanent fallback URL (handles can change).
- `/[handle]/series/[rkey]` — series page, record-ordered.
- `/photo/[did]/[collection]/[rkey]` — photo detail; the route triple is the AT-URI. 2048px rendition, caption, EXIF panel, license, tags, source link ("view on Bluesky" / "view on their site"). Lightbox with keyboard nav; alt text throughout.
- `/register`, `/settings`, `/dmca`, `/about` — app routes.

**SEO/sharing:** every photo/profile page emits OG tags with a proxied rendition; sitemap generated. A photography hub lives on link previews.

**Image proxy:** `/img/[did]/[cid]/[preset]`, presets `thumb` 512 / `feed` 1024 / `full` 2048, AVIF/WebP negotiated. Blobs are content-addressed → responses are `Cache-Control: immutable`; the CDN absorbs repeat traffic and the function runs only on first sight of a rendition. Escape hatch if egress costs bite: Cloudflare in front.

**Registration & auth:** ATProto OAuth via `@atproto/oauth-client-node` (authorization code + PKCE + DPoP). The app serves its public `client-metadata.json` and holds its signing keys (JWKS) in env — required by the confidential-client flow. Photographer enters handle → PDS auth screen → DPoP-bound session; DID stored in an encrypted cookie session. Flow: OAuth → source toggles → backfill status screen → "your photos are live." **Registration policy is a knob:** v1 auto-approves, but `status = 'pending_review'` exists in-schema so juried admission is config, not migration. Admins = allowlist of DIDs; takedown writes `photo_overrides`.

**Settings:** source toggles, per-photo hide grid (writes `photo_overrides`; Luminance-lexicon records are always shown — publishing them *is* the curation act), de-registration (index rows removed; durable state retained).

Phase-1 viewers browse anonymously. Sign-in is protocol-standard OAuth, so phase 2's viewer accounts reuse this stack unchanged.

## 11. Security

- **The image proxy is not an open proxy:** it serves only blobs the index references (photo `blob_cid`s, photographer avatars) — anything else 404s before any upstream fetch. The allowlist check is one indexed lookup.
- **SSRF defense:** PDS endpoints come from attacker-controllable DID documents. All server-side fetches (proxy, backfill, resolution) enforce HTTPS-only and public-IP-only at fetch time.
- Both guards carry permanent regression tests (§13).
- Standard baseline: encrypted sessions, no secrets client-side, admin actions audit-logged.

## 12. Error handling & observability

- **Ingestor:** invalid records are skipped and counted, never crash the stream (a poison event costs one photo, not the pipeline). Jetstream disconnects → exponential backoff, cursor resume. Backfill failures → retry with backoff, resumable via stored cursors, `failed` status visible in settings with manual retry.
- **Web:** OAuth failures (PDS down, denial, refresh death) land on friendly retry screens. Blob fetch failures return short-lived negative-cache 502s so dead PDSes aren't hammered; aspect-ratio boxes make missing images degrade gracefully. Empty states designed.
- **Observability:** Sentry on both apps. Ingestor metrics track the design's actual failure modes: cursor lag (alert threshold), mapper error rate, backfill queue depth, proxy cache hit ratio. Fly health checks on the worker.
- **Backup:** Neon PITR covers durable app-state tables; index tables need no backup by design.
- **Migrations:** Drizzle migrations run in CI before either app deploys (shared `packages/db`; neither app races an unknown schema).

## 13. Testing & CI

- **Mappers get the deepest coverage** (correctness lives there): golden fixtures of real captured Bluesky/Grain/Luminance records → expected rows; label preservation, `group_key` grouping, reply/quote skipping, `sort_at` clamping.
- **Security regression tests:** SSRF guard (internal-IP PDS refused, HTTP refused) and proxy allowlist (non-indexed blob → 404) as permanent fixtures.
- **Integration via `@atproto/dev-env`** (official local PDS stack): create account, write records, run real backfill + live ingestion; regression-test the delete-during-backfill tombstone race specifically.
- **E2E (Playwright):** feed render, per-photo hide, label blur, proxy headers. CI exercises OAuth callback/session handling with a stubbed identity; the full OAuth round-trip against dev-env is a scripted local smoke test run before releases (not per-commit — honest about CI feasibility).
- **CI (GitHub Actions + Turbo):** typecheck, lint, tests, lexicon-codegen drift check. Vercel deploys `apps/web`; Fly deploys `apps/ingestor`.

## 14. Open questions (deferred, with owners)

- **Phase 4:** provision accounts on bsky.social via API vs. running `pds.luminance.social`. (Own PDS also raises the blob-size ceiling — relevant to print-quality ambitions.)
- **Phase 2:** interactions via Bluesky lexicons (max interop) vs. `social.luminance.*` (portfolio-grade semantics). Leaning decision deferred until Foundation ships.
- **Policy:** whether/when to flip registration from auto-approve to juried. Schema supports both.

## 15. Foundation success criteria (proposed)

1. Kevin + at least two photographer friends with existing ATProto accounts registered and visible in the hub.
2. A photo posted on Bluesky appears in the hub feed within 60 seconds (live path proven).
3. Full index drop + rebuild drill converges to identical feed output (AppView contract proven).
4. Lighthouse ≥ 90 on feed and photo pages on mobile (a photography hub that's slow is dead).
