# OpenContent Commons + Portfolio Framework (Phase 3a) — Design

> **Status as of 2026-07-30: partially executed.** Framework (openportfolio)
> and hub adoption shipped 2026-07-28; commons publication is blocked on
> registering `opencontent.social`; the klee.photos flagship is pending. The
> `social.opencontent.*` schemas now live in the sibling
> `opencontent-lexicons` repo (source of truth). See the matching plan's
> banner and `docs/TODO.md`.

_Approved through section-by-section review 2026-07-25 → 2026-07-28. Supersedes the phase-3 "publisher core" framing in docs/TODO.md §2._

## 1. Overview

Two deliverables, one thesis:

1. **The `social.opencontent.*` vocabulary** — a BDFL-governed lexicon commons for user-generated content, anchored at the (to-be-registered) domain **opencontent.social**. Kevin defines and evolves it under published rules; anyone may adopt it; governance can transfer later by transferring the domain + steward account (NSIDs never change).
2. **The portfolio framework — named "openportfolio"** (repo `iserlabs/openportfolio`; the name is brand-only — the namespace is governance-independent, so even this can change without schema impact): a self-hostable, ATProto-native portfolio CMS. One Next.js app (admin CMS + public site) composed with the unmodified reference PDS. The owner's portfolio lives as `social.opencontent.*` records in their own repo; the app is a writer/renderer, never a silo.

**Flagship:** klee.photos rebuilt on the framework — self-hosted PDS at `pds.klee.photos`, Kevin's **new** account (fresh DID, decision b2 below), handle `@klee.photos`. luminance.social indexes the commons vocabulary as one aggregator among potentially many.

**Explicitly out of scope (filed follow-ups):** productization (themes, installer wizard, docs site, releases — "spec 2"); luminance-source interactions (phase 3b, filed in TODO §2); phase 4 hosted onboarding (which becomes "hosted version of this framework").

## 2. Decisions log (with rationale)

| # | Decision | Rationale |
|---|---|---|
| D1 | New dedicated account / fresh DID for the portfolio; old `kevinleephotos` DID retires from Luminance after content parity (**b2**) | Kevin's choice; accepts follower/history reset. DIDs cannot be merged or transferred — decided with that understood |
| D2 | Self-hosted PDS (reference PDS, unmodified, version-pinned) | Full sovereignty thesis; configurable blob limits for portfolio-grade files; PDS migration preserves the DID if this ever changes |
| D3 | Web-upload CMS (not CLI/folder sync) | klee.photos rebuild doubles as a product; IPTC/EXIF prefill preserves the Lightroom metadata pipeline through the browser |
| D4 | Vocabulary in a neutral commons namespace, NOT `social.luminance.*`, NOT `com.iserlabs.*` | CMS must be independent of any aggregator (transport already is, by protocol; this fixes schema *governance*). Domain: **opencontent.social** |
| D5 | Flat type names — `photograph`, not `portfolio.photo` | "Portfolio" is a use, not a kind. Flat names let social apps, blogs, and aggregators adopt the same types. Minimum-3-segment NSID rule permits this |
| D6 | BDFL governance with published rules; standardization as exit | Public lexicon repo (PRs welcome, Kevin merges), additive-only evolution (breaking = new NSID), permissive license on schema docs. Hand-off = domain + steward-account transfer |
| D7 | Reuse `app.bsky.actor.profile` for identity display; no custom profile type until a real need | YAGNI; every ATProto surface already understands it |
| D8 | Site config in-repo as `social.opencontent.site` (rkey `self`) | "Export = everything" — presentation intent migrates with the account. Flagged judgment call: fields kept generic (title/about/nav/links/theme-string) so any renderer can honor them |
| D9 | Architecture A: one app + composed PDS (`[caddy, pds, app]`) | WordPress shape; one deploy story for self-hosters. Split apps and static-gen considered and rejected (§App) |
| D10 | Flagship dogfoods the real compose on one small VPS | The install path we ship is the install path we run |

## 3. The lexicons (v1 — deliberately two types)

Authority for all: `opencontent.social` → **one** `_lexicon.opencontent.social` TXT → steward DID. Schema documents live as `com.atproto.lexicon.schema` records in the **steward account** `@opencontent.social`, hosted on the flagship PDS; the steward's *handle* verifies via a `_atproto.opencontent.social` DNS TXT record (no website needs to exist on that domain for v1 — two TXT records are the entire footprint). Governance repo `iserlabs/opencontent-lexicons` is source of truth; publish via `goat` (pipeline proven for luminance's lexicons).

### `social.opencontent.photograph` — one record = one work (single image; a diptych is two photographs in a collection)

| field | type | constraints |
|---|---|---|
| `image` | blob | accept: `image/jpeg, image/png, image/webp, image/avif, image/heic` — explicit raster allowlist, **no SVG** (script-vector for naive consumers that serve blobs raw); maxSize 20MB advisory (host-PDS limit is the effective ceiling) |
| `aspectRatio` | `{width: int, height: int}` | **required** — renderers lay out before fetching bytes (CLS-0 enabler) |
| `title` | string | ≤200 graphemes, optional |
| `description` | string | ≤2000, optional (caption) |
| `alt` | string | ≤2000, optional — accessibility text, distinct from caption |
| `exif` | object | optional; all-optional members: `camera` (string), `lens` (string), `focalLength` (string), `fNumber` (string — lexicons have no float type; "2.8" round-trips exactly), `shutterSpeed` (string), `iso` (integer) — matches the hub's existing display contract |
| `tags` | string[] | ≤20 items, each ≤64 graphemes |
| `license` | string | ≤200, freeform; SPDX recommended in docs |
| `location` | string | ≤200, optional — *deliberate* place statement; never auto-filled from GPS |
| `capturedAt` | datetime | optional |
| `createdAt` | datetime | required |
| `labels` | `com.atproto.label.defs#selfLabels` | optional self-labels → standard blur machinery |

### `social.opencontent.collection`

| field | type | constraints |
|---|---|---|
| `title` | string | required, ≤200 |
| `description` | string | ≤2000, optional |
| `items` | `com.atproto.repo.strongRef[]` | maxLength 500; **array order = display order** (inline array: authoritative order, atomic reorder via one putRecord; ~150B/ref keeps worst case far under record-size limits) |
| `cover` | strongRef | optional; renderers fall back to first resolvable item |
| `createdAt` | datetime | required |

**Consumer rules (documented in the lexicon repo):** tolerate dangling refs (deleted photograph referenced by a collection → skip, never error); unknown fields ignored (additive evolution); collections absent from `site.collectionOrder` render **after** the ordered ones, newest first (unlisted ≠ hidden — hiding is deletion or a future explicit field, never an ordering side effect).

### `social.opencontent.site` (rkey `self`, one per repo)

`title` (≤200), `about` (≤5000, optional), `collectionOrder` (**rkey strings**, ≤100 — public-site nav order; rkeys, not at-uris, because the record can only ever order collections in its own repo and embedding the repo's own DID in every entry is redundant), `links` (≤10 of `{label ≤50, uri}`), `theme` (≤64 freeform string; product-specific values allowed), `createdAt`.

**Rkeys:** TIDs for photographs/collections; `self` for site.

## 4. The framework application

One Next.js 16 / React 19 / Tailwind 4 app. **No Postgres**: OAuth client state (states/sessions) in SQLite on a volume; iron-session cookies; in-process TTL cache for record reads, **busted by admin write actions** (publish must be immediately visible to its author).

### Admin (`/admin`)
- OAuth sign-in against **any** PDS (port of Luminance's `@atproto/oauth-client-node` integration; app serves its own `/oauth/client-metadata.json`). Only `OWNER_DID` (env) receives admin; all others rejected.
- **Upload:** drag-drop (multi-file) → server parses embedded IPTC/EXIF → prefills title/description/alt/tags/capturedAt → **GPS stripped from blob by default, metadata-only surgery (no pixel re-encode — masters are never recompressed);** camera EXIF preserved; per-upload opt-in to keep GPS → `uploadBlob` + `createRecord`. Oversize files: client-side downscale offer when the PDS rejects (413) rather than a dead error.
- **Collections:** create/edit, drag-reorder (one `putRecord` rewrites `items`), set cover, add/remove photographs. Delete photograph warns when collections still reference it.
- **Site settings:** edits the `social.opencontent.site` record (title, about, nav order, links, theme).
- **Sovereignty surface:** "Download my data" (repo CAR via `com.atproto.sync.getRepo` + blob archive) — always available, no conditions.

### Public site
- `/` — nav from `site.collectionOrder`; the grid shows the **first collection in `collectionOrder`** (matching the Format site's landing-on-Street behavior), falling back to all photographs reverse-chronological when no collections exist. `/c/[rkey]` collection page; `/p/[rkey]` photograph page (title/caption/EXIF/tags/license/location, lightbox with keyboard nav); `/about` from `site.about`.
- Server-rendered from the configured PDS (`listRecords`/`getRecord` + TTL cache). Image proxy `/img/[cid]/[preset]` — the Luminance-hardened pattern (presets incl. 768px, content negotiation, immutable caching, blur-up placeholders, srcset) **simplified by pinning fetches to the single configured PDS host** (no general SSRF surface).
- `/.well-known/atproto-did` returns `OWNER_DID` → owning the website domain *is* the handle verification. No extra DNS for the handle.
- OG tags per photograph/collection page.

## 5. Deployment, bootstrap, sovereignty

**Compose:** `caddy` (TLS; routes `pds.<domain>` → PDS, apex → app) · reference PDS (pinned image; `PDS_BLOB_UPLOAD_LIMIT=32MB`) · app (SQLite volume). One `.env`: domain, secrets, `OWNER_DID` (written by setup).

**`setup.sh` (first run):**
1. **Preflight:** apex + `pds.` DNS resolve to this host; ports open; TLS issuable. Refuses to continue past a failure, with fix-this messaging.
2. Stack up → owner account created on the PDS (`pdsadmin`-equivalent invite flow) → `OWNER_DID` into `.env`.
3. **Recovery-key ceremony:** generate rotation keypair, register on the DID with priority over the PDS key, hand the private key to the owner (download + store-offline instructions). Docs state the honest guarantee: priority key = **72-hour window** to override a hostile op — time to notice and recover, not immunity.
4. **Relay crawl request** so the account is live on Bluesky's network immediately.

**Backups:** the app schedules the nightly export itself (it's the always-on process — no fourth cron container): dated CAR + blob snapshot to a mounted backup dir; off-box sync documented as operator responsibility.

**Migrate-away:** `goat`-based runbook to move the account to any other PDS — **executed once against a scratch PDS before release** (untested exit doors are decoration).

**Flagship & cutover:** one small VPS (~€5) running this exact compose. Development on a **staging hostname**; `klee.photos` DNS (currently Format.com) flips only at acceptance — Format remains the instant rollback until then. `pds.klee.photos` + apex on Cloudflare, DNS-only/grey-cloud (PDS and caddy terminate their own TLS).

## 6. Luminance-side changes (small by design)

- Watch `social.opencontent.photograph` + `.collection`; mapper per the `mapLuminancePhoto` pattern (single image, mediaIndex 0, `aspectRatio`→width/height, selfLabels→blur, EXIF/tags/license/location→existing columns). Collections → existing series tables via the authoritative-inline-array path; `items[].uri`→seriesPhotos, `cover`→coverPhotoUri.
- **Migration 0006:** `photo_source` enum gains `opencontent`. ⚠ `ALTER TYPE … ADD VALUE` is transaction-hostile (drizzle wraps migrations transactionally; even PG12+ can't *use* the value in the same transaction) — the enum add ships as its own non-transactional/`IF NOT EXISTS` step, verified on Neon **and** PGlite before CI.
- **Retire `social.luminance.portfolio.*`:** delete from watched collections, mappers, published set. Zero records ever existed — code deletion, not data migration.
- Interactions router: explicit `opencontent → {supported:false}` (3b seam; UI already renders it honestly).
- Everything else is source-agnostic already: freshness probe (discovers `pds.klee.photos` via DID resolution), reconciliation, image proxy, feed/detail/lightbox, registration OAuth. The new account registers like any photographer. No opt-out toggle for opencontent (the portfolio is the point; toggles stay bsky/grain-only).

## 7. Testing & acceptance

**Framework:** units — IPTC prefill parser; **GPS-strip invariant** (geotagged fixture → output has zero GPS tags AND byte-identical pixel data); record builders; pinned-host proxy; publish-busts-cache; well-known route; dangling-ref rendering; owner-gate logic. **Integration** (`@atproto/dev-env`, SQLite-native): real PDS → account → upload → records → public pages render; export CAR validates. **E2E** (Playwright, against dev-env — its plain login form is scriptable, production OAuth is not): the full author loop, drag-drop → prefill → publish → public page.

**Hub:** mapper units from fixture records; migration 0006 exercised in PGlite; reconciliation walk over both new collections.

**Flagship acceptance (definition of done):**
1. klee.photos serves the portfolio entirely from PDS records (nav, collection pages, photograph pages, lightbox).
2. `@klee.photos` resolves; a post from the new account is visible on Bluesky (crawl proven).
3. New account completes standard Luminance registration; an admin upload appears on klee.photos immediately and on luminance.social within ~1 min (probe + backfill), source `opencontent`.
4. `goat lex resolve social.opencontent.photograph` succeeds from a clean machine.
5. "Download my data" CAR restores onto a scratch PDS (migration runbook executed for real).
6. Recovery-key ceremony complete; key offline with Kevin.
7. Old account untouched until parity; deregistration is Kevin's explicit later action.
8. klee.photos public pages: **Lighthouse ≥90 mobile and desktop, CLS 0**.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `opencontent.social` domain lapse = vocabulary-wide incident | Multi-year registration + registrar lock + renewal reminders; treat like a signing key |
| Enum migration trap (§6) | Isolated non-transactional step; tested on Neon + PGlite pre-CI |
| Reference-PDS upgrades break compose | Version pin + documented upgrade procedure; flagship upgrades first |
| Self-hosted OAuth rough edges | Patterns already battle-tested in Luminance; dev-env integration coverage |
| Kevin's b2 identity reset misunderstood later | Decisions log D1 records that follower/history loss was explicit and accepted |
| klee.photos cutover breaks live site | Staging-first; DNS flip at acceptance; Format rollback until parity |

## 9. Global constraints

- TypeScript, pnpm, Next.js 16, React 19, Tailwind 4, Vitest, Playwright (stack parity with Luminance).
- Reference PDS **unmodified** — composition only, never a fork.
- Security invariants carried from Luminance: scheme-checked external hrefs, pinned-host blob fetches, re-encoded image serving, no secrets in records or logs.
- Commons purity: nothing product-specific enters `social.opencontent.*` beyond D8's generic site record; evolution additive-only.
- Prerequisites before implementation: register **opencontent.social**; provision staging VPS + scratch hostname.
