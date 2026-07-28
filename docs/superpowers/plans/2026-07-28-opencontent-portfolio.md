# OpenContent Commons + Portfolio Framework (Phase 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `social.opencontent.*` lexicon commons, the self-hostable ATProto portfolio framework (`iserlabs/open-portfolio`), Luminance's adoption of the commons, and the klee.photos flagship deployment.

**Architecture:** One Next.js 16 app (admin CMS + public portfolio) reading/writing the owner's own ATProto repo, composed via docker-compose with the unmodified reference PDS behind caddy. Luminance indexes the new vocabulary as one aggregator among many. Spec: `docs/superpowers/specs/2026-07-28-opencontent-portfolio-design.md` — the plan implements it exactly; where this plan and the spec disagree, the spec governs.

**Tech Stack:** TypeScript, pnpm workspaces, Next.js 16 / React 19 / Tailwind 4, `@atproto/api` + `@atproto/oauth-client-node` + `@atproto/dev-env`, better-sqlite3, sharp + exifr + exiftool-vendored, Vitest, Playwright, docker-compose + caddy + reference PDS image.

## Global Constraints (verbatim from spec §9)

- TypeScript, pnpm, Next.js 16, React 19, Tailwind 4, Vitest, Playwright (stack parity with Luminance).
- Reference PDS **unmodified** — composition only, never a fork.
- Security invariants carried from Luminance: scheme-checked external hrefs, pinned-host blob fetches, re-encoded image serving, no secrets in records or logs.
- Commons purity: nothing product-specific enters `social.opencontent.*` beyond the generic site record; evolution additive-only.
- Lexicon field tables in spec §3 are exact: field names, types, and limits must match verbatim.
- GPS stripping is metadata-only surgery — pixel data must be byte-identical after strip.
- The framework app uses **no Postgres** (SQLite only).
- Blob accept list: `image/jpeg, image/png, image/webp, image/avif, image/heic` — never SVG.

## Human gates (not agent tasks)

- **G0 (before Part C):** Kevin registers `opencontent.social` (multi-year + registrar lock) and adds two TXT records: `_lexicon.opencontent.social` and `_atproto.opencontent.social` → steward DID (values produced by Task C2).
- **G1 (before Part D):** Kevin provisions the staging VPS + a scratch hostname pair (apex + `pds.`) pointed at it.
- **G2 (cutover):** Kevin flips klee.photos DNS at acceptance; Format stays as rollback.

New repo location: `~/workspace/open-portfolio` (GitHub `iserlabs/open-portfolio`, created in Task A1).

---

## Part A — Framework repo foundations

### Task A1: Repo scaffold

**Files:**
- Create: `~/workspace/open-portfolio/` — `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `apps/site/` (Next.js 16 app: `package.json`, `next.config.ts`, `tsconfig.json`, `app/layout.tsx`, `app/page.tsx`, `postcss.config.mjs`, `app/globals.css`), `packages/lexicons/` (`package.json`, `tsconfig.json`, `src/index.ts`), `.github/workflows/ci.yml`, `.gitignore`, `README.md`

**Interfaces:**
- Produces: workspace commands `pnpm build`, `pnpm test`, `pnpm typecheck` (turbo across `apps/site` + `packages/lexicons`); `apps/site` renders a placeholder page.

- [ ] **Step 1: Scaffold** — mirror the luminance repo's workspace shape (copy `package.json`/`turbo.json`/`pnpm-workspace.yaml` from `~/workspace/luminance.social` and trim to two packages). `apps/site` via `pnpm create next-app@latest apps/site --ts --app --tailwind --no-eslint --src-dir=false --import-alias "@/*"`; pin `react@^19`, `next@^16`. `packages/lexicons/src/index.ts` exports `export const OPENCONTENT_PHOTOGRAPH = "social.opencontent.photograph"; export const OPENCONTENT_COLLECTION = "social.opencontent.collection"; export const OPENCONTENT_SITE = "social.opencontent.site";`
- [ ] **Step 2: CI** — `.github/workflows/ci.yml` copied from luminance's, minus the migration step (no DB here):

```yaml
name: ci
on: { push: { branches: [main] }, pull_request: {} }
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 3: Verify** — `pnpm build && pnpm typecheck && pnpm test` (vitest `--passWithNoTests`) all exit 0.
- [ ] **Step 4: Create GitHub repo + push** — `gh repo create iserlabs/open-portfolio --private --source . --push` (private until release; Kevin flips visibility at productization).
- [ ] **Step 5: Commit** any stragglers; CI green on GitHub.

### Task A2: Lexicon schemas + record builders

**Files:**
- Create: `packages/lexicons/lexicons/social/opencontent/photograph.json`, `collection.json`, `site.json`; `packages/lexicons/src/records.ts`; Test: `packages/lexicons/src/records.test.ts`, `packages/lexicons/src/schemas.test.ts`

**Interfaces:**
- Produces: `buildPhotograph(input: PhotographInput): PhotographRecord`, `buildCollection(input: CollectionInput): CollectionRecord`, `buildSite(input: SiteInput): SiteRecord` — each validates limits and throws `Error` with a human message on violation. Types exported. `PhotographInput.image` is `BlobRef`-shaped (`{ $type: "blob", ref, mimeType, size }`).

- [ ] **Step 1: Write the three schema JSONs** exactly from spec §3 tables. `photograph.json` (the other two follow the same encoding of their tables):

```json
{
  "lexicon": 1,
  "id": "social.opencontent.photograph",
  "defs": {
    "main": {
      "type": "record",
      "description": "One photographic work: a single image with portfolio-grade metadata.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["image", "aspectRatio", "createdAt"],
        "properties": {
          "image": { "type": "blob", "accept": ["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic"], "maxSize": 20971520 },
          "aspectRatio": { "type": "ref", "ref": "#aspectRatio" },
          "title": { "type": "string", "maxGraphemes": 200, "maxLength": 800 },
          "description": { "type": "string", "maxGraphemes": 2000, "maxLength": 8000 },
          "alt": { "type": "string", "maxGraphemes": 2000, "maxLength": 8000 },
          "exif": { "type": "ref", "ref": "#exif" },
          "tags": { "type": "array", "maxLength": 20, "items": { "type": "string", "maxGraphemes": 64, "maxLength": 256 } },
          "license": { "type": "string", "maxGraphemes": 200, "maxLength": 800 },
          "location": { "type": "string", "maxGraphemes": 200, "maxLength": 800 },
          "capturedAt": { "type": "string", "format": "datetime" },
          "createdAt": { "type": "string", "format": "datetime" },
          "labels": { "type": "union", "refs": ["com.atproto.label.defs#selfLabels"] }
        }
      }
    },
    "aspectRatio": {
      "type": "object",
      "required": ["width", "height"],
      "properties": { "width": { "type": "integer", "minimum": 1 }, "height": { "type": "integer", "minimum": 1 } }
    },
    "exif": {
      "type": "object",
      "properties": {
        "camera": { "type": "string", "maxLength": 256 }, "lens": { "type": "string", "maxLength": 256 },
        "focalLength": { "type": "string", "maxLength": 64 }, "fNumber": { "type": "string", "maxLength": 64 },
        "shutterSpeed": { "type": "string", "maxLength": 64 }, "iso": { "type": "integer", "minimum": 0 }
      }
    }
  }
}
```

`collection.json`: record key `tid`; required `["title", "items", "createdAt"]`; `items` array maxLength 500 of `com.atproto.repo.strongRef`; optional `description` (≤2000 graphemes), `cover` (strongRef). `site.json`: record key `literal:self`; required `["title", "createdAt"]`; `about` ≤5000 graphemes; `collectionOrder` array maxLength 100 of `{ "type": "string", "format": "record-key" }`; `links` array maxLength 10 of `#link` (`label` ≤50 graphemes, `uri` format `uri`, both required); `theme` string maxLength 64. Copy `strongRef.json` and `label/defs.json` from `~/workspace/luminance.social/packages/lexicons/lexicons/com/atproto/` into the same relative paths here (schemas referenced must resolve locally).

Note (spec §3 exif contract): `fNumber` is a **string** in the lexicon (lexicon has no float type; "2.8" round-trips exactly); the hub's display treats string|number interchangeably, verified in Task C1.

- [ ] **Step 2: Failing schema tests** — `schemas.test.ts`: load all JSONs into `new Lexicons()` from `@atproto/lexicon`; `lex.assertValidRecord("social.opencontent.photograph", validFixture)` passes; fixtures violating each constraint (SVG mime, missing aspectRatio, 501-item collection, non-self site rkey is builder-level) throw. Run: fails (files don't exist yet ordering — write JSONs in step 1 makes these pass immediately; acceptable — the failing phase is the fixtures for `records.ts`).
- [ ] **Step 3: `records.ts` builders + failing tests** — grapheme counting via `Intl.Segmenter` (copy `graphemeLength` from `~/workspace/luminance.social/packages/atproto/src/interaction-records.ts`); builders fill `$type` + `createdAt` (ISO now unless supplied), validate every spec limit, reject `items.length > 500`, reject links >10, reject unknown mime for `image.mimeType`. Tests: happy path per type; one violation per limit; `buildSite` output's rkey convention documented (`self` used by callers).
- [ ] **Step 4: Run** — `pnpm --filter @open-portfolio/lexicons test` → all pass.
- [ ] **Step 5: Commit** — `feat(lexicons): social.opencontent.* v1 schemas + validated record builders`

### Task A3: EXIF/IPTC prefill + GPS strip

**Files:**
- Create: `apps/site/lib/photo-metadata.ts`; Test: `apps/site/lib/photo-metadata.test.ts`; fixtures `apps/site/lib/fixtures/` (generate in-step: a JPEG with GPS + IPTC written via exiftool-vendored in a test helper, not committed binaries)

**Interfaces:**
- Produces: `extractPrefill(buf: Buffer): Promise<Prefill>` where `Prefill = { title?: string; description?: string; alt?: string; tags: string[]; capturedAt?: string; exif: { camera?, lens?, focalLength?, fNumber?, shutterSpeed?, iso? }; width: number; height: number; hasGps: boolean }`; `stripGps(buf: Buffer): Promise<Buffer>` — metadata-only; throws on unsupported container rather than silently recompressing.

- [ ] **Step 1: Failing tests** — build fixture in `beforeAll`: `sharp({create:{width:64,height:40,channels:3,background:"#357"}}).jpeg().toBuffer()`, then `exiftool.write` (exiftool-vendored) adding `GPSLatitude: 40.7, GPSLongitude: -73.9, Title: "Main Street", Description: "Subway platform", Keywords: ["street","nyc"], Make: "FUJIFILM", Model: "X-T5", LensModel: "XF 35mm", FNumber: 2.8, ExposureTime: "1/250", ISO: 800, FocalLength: "35 mm", DateTimeOriginal: "2026:05:01 10:00:00"`. Tests: (a) `extractPrefill` returns title "Main Street", description, tags `["street","nyc"]`, exif fields as spec types (fNumber `"2.8"` string, iso 800 int), width 64/height 40, `hasGps: true`; (b) `stripGps` output: exiftool read shows **zero** GPS tags, still shows Make/Model; (c) **pixel invariant**: `sharp(stripped).raw().toBuffer()` equals `sharp(original).raw().toBuffer()` (Buffer.compare === 0); (d) non-geotagged input returns `hasGps: false` and `stripGps` is a no-op passthrough.
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** — `extractPrefill` via `exifr.parse(buf, { iptc: true, tiff: true, exif: true, gps: true })` + `sharp(buf).metadata()` for dimensions; normalize (`FNumber` → string via `String()`, `ExposureTime` 0.004 → `"1/250"` using nearest-reciprocal formatting when <1). `stripGps` via `exiftool-vendored` `deleteAllTagsArgs`-scoped call: `exiftool.write(tmp, {}, ["-gps:all=", "-overwrite_original"])` on a temp file, return bytes (exiftool never touches image data). Supported containers: jpeg/png/webp/heic per accept list; avif → throw `"gps strip unsupported for avif; re-export without location"` (exiftool avif write support is unreliable — honest failure beats silent pass-through of GPS).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `feat(site): IPTC/EXIF prefill + metadata-only GPS strip with pixel-invariance tests`

### Task A4: Pinned PDS read client + TTL cache

**Files:**
- Create: `apps/site/lib/pds.ts`, `apps/site/lib/env.ts`; Test: `apps/site/lib/pds.test.ts`

**Interfaces:**
- Consumes: `OPENCONTENT_*` constants (A2).
- Produces: `env` (lazy getters: `PDS_URL`, `OWNER_DID`, `PUBLIC_URL`, `SESSION_SECRET`, `SQLITE_PATH`, `BACKUP_DIR?`); `listAllRecords<T>(collection: string): Promise<{uri: string; cid: string; value: T}[]>` (pages `com.atproto.repo.listRecords` at limit 100 to exhaustion, capped 5000); `getRecord<T>(collection, rkey)`; `blobUrl(cid: string): string` (\`${PDS_URL}/xrpc/com.atproto.sync.getBlob?did=${OWNER_DID}&cid=${cid}\`); `cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>` and `bustCache(prefix?: string)` — in-process Map. All fetches go only to `env.PDS_URL` (pinned host — never a caller-supplied origin).

- [ ] **Step 1: Failing tests** — inject `fetchJson` stub: paging joins 3 pages then stops on missing cursor; cap at 5000; `cached` returns stale within TTL, refetches after, `bustCache()` clears immediately; `blobUrl` percent-encodes the DID.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (env.ts mirrors luminance's lazy-getter pattern from `apps/web/lib/env.ts`). **Step 4: Run** → PASS. **Step 5: Commit** — `feat(site): pinned PDS read client with paged listing and bustable TTL cache`

### Task A5: OAuth admin auth (SQLite-backed)

**Files:**
- Create: `apps/site/lib/db.ts` (better-sqlite3 open + schema: `oauth_states(key TEXT PRIMARY KEY, state TEXT, created_at INTEGER)`, `oauth_sessions(key TEXT PRIMARY KEY, session TEXT, updated_at INTEGER)`, `blur(cid TEXT PRIMARY KEY, data_url TEXT)`), `apps/site/lib/oauth.ts`, `apps/site/lib/session.ts`, `apps/site/app/oauth/client-metadata.json/route.ts`, `apps/site/app/oauth/callback/route.ts`, `apps/site/app/admin/login/page.tsx`
- Test: `apps/site/lib/oauth-stores.test.ts`, `apps/site/lib/session.test.ts`

**Interfaces:**
- Produces: `getOAuthClient(): Promise<NodeOAuthClient>` (state/session stores backed by SQLite tables above); `getSession(): Promise<{ did?: string; handle?: string; isOwner: boolean }>` (`isOwner = did === env.OWNER_DID`); `requireOwner(): Promise<string>` throws/redirects for non-owners; `restoreAgent(did): Promise<Agent>`.

- [ ] **Step 1: Port** — copy `apps/web/lib/oauth.ts`, `oauth-state.ts`, `session.ts`, and the login/callback routes from `~/workspace/luminance.social/apps/web` (commit `d52c18f` tree), then: replace every Drizzle store call with synchronous better-sqlite3 statements (`INSERT OR REPLACE`, `SELECT`, `DELETE`); replace `isAdmin` with `isOwner` (`OWNER_DID` equality — no ADMIN_DIDS list); client metadata `client_id` = `${PUBLIC_URL}/oauth/client-metadata.json`, scope unchanged.
- [ ] **Step 2: Failing store tests** — state roundtrip (set/get/del), session upsert-then-update, TTL cleanup helper `pruneOauthStates(olderThanMs)` deletes stale only. Session test: cookie decode mirrors luminance's `session.test.ts` (port it).
- [ ] **Step 3: Run** → PASS after wiring. **Step 4: Commit** — `feat(site): OAuth sign-in with SQLite stores; owner-gated admin identity`

### Task A6: Publish pipeline (server actions)

**Files:**
- Create: `apps/site/app/admin/actions.ts`; Test: `apps/site/app/admin/actions.test.ts`

**Interfaces:**
- Consumes: `buildPhotograph`/`buildCollection`/`buildSite` (A2), `extractPrefill`/`stripGps` (A3), `requireOwner`/`restoreAgent` (A5), `bustCache` (A4).
- Produces: `publishPhotograph(formData): Promise<{ok:true; uri:string} | {ok:false; error:string; code?: "too-large"}>` — strip GPS (unless `keepGps==="true"`) → `agent.uploadBlob` → `createRecord` → `bustCache()`; PDS 413 → `{ok:false, code:"too-large"}` (client offers downscale, A7). `saveCollection(formData)` (create or `putRecord` full rewrite — reorder = same call), `deleteRecordAction(formData)` (collection-membership warning data returned, not enforced), `saveSite(formData)`.

- [ ] **Step 1: Failing tests** — stubbed agent (luminance's `makeFakeAgent` pattern from `apps/web/lib/interactions.test.ts`): publish calls uploadBlob then createRecord with `$type` `social.opencontent.photograph` and the blob ref threaded through; GPS-strip called by default, skipped with keepGps; 413 error from uploadBlob maps to `code:"too-large"`; every ok path calls `bustCache` (spy); non-owner session rejected before any agent call.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** — `feat(site): owner publish/collection/site server actions with cache bust and 413 mapping`

### Task A7: Admin UI

**Files:**
- Create: `apps/site/app/admin/page.tsx` (dashboard: counts + quick links), `apps/site/app/admin/upload/page.tsx` + `upload-form.tsx` (client), `apps/site/app/admin/collections/page.tsx` + `collection-editor.tsx` (client, drag-reorder via HTML5 DnD, no library), `apps/site/app/admin/site/page.tsx` + `site-form.tsx`, `apps/site/components/admin-shell.tsx`
- Test: covered by A6 action tests + A13 E2E (UI components stay logic-thin; any extracted pure helpers get colocated unit tests)

- [ ] **Step 1: Build pages** — upload: dropzone (multi-file), per-file card prefilled from `extractPrefill` (fields: title, description, alt, tags, license, location, capturedAt read-only exif summary, keep-GPS checkbox shown only when `hasGps`), publish per file with pending/error states (413 → "Downscale to fit" button: client-side canvas resize to ≤PDS limit at 0.92 quality, then re-submit — the ONLY place recompression is allowed, and it's explicit user opt-in on a rejected upload). Collections: list + editor (order via drag; save = one `saveCollection`); delete photograph flow surfaces "referenced by N collections" from the membership data. Site: title/about/nav-order/links/theme form.
- [ ] **Step 2: Verify manually against dev-env** (A12 harness prerequisite may land later — until then `pnpm dev` + a bsky.social test account is acceptable for eyeballing).
- [ ] **Step 3: Commit** — `feat(site): admin dashboard, upload, collections, and site settings UI`

### Task A8: Public site

**Files:**
- Create: `apps/site/lib/portfolio.ts`; pages `apps/site/app/(public)/page.tsx`, `c/[rkey]/page.tsx`, `p/[rkey]/page.tsx`, `about/page.tsx`; `apps/site/app/.well-known/atproto-did/route.ts`; `apps/site/components/{photo-grid,photo-card,lightbox}.tsx` (port grid/card/lightbox from `~/workspace/luminance.social/apps/web/components/`, swapping data props to opencontent shapes)
- Test: `apps/site/lib/portfolio.test.ts`

**Interfaces:**
- Consumes: A4 client + cache.
- Produces: `getPortfolio(): Promise<{ site: SiteRecord|null; collections: OrderedCollection[]; photographs: Map<string /*rkey*/, PhotographRecord & {cid:string}> }>` — 60s TTL; **ordering rule from spec:** collections in `site.collectionOrder` first (that order), then unlisted newest-first; dangling `items[]` refs resolve to nothing and are skipped.

- [ ] **Step 1: Failing tests for `getPortfolio`** — stubbed records: order honors collectionOrder; unlisted collection appended newest-first; dangling ref skipped without throw; no site record → all collections newest-first and `site` null.
- [ ] **Step 2: Run** → FAIL; implement; PASS.
- [ ] **Step 3: Pages** — `/` renders first ordered collection's grid (fallback: all photographs reverse-chron); `/c/[rkey]`; `/p/[rkey]` full photograph page (title/caption/EXIF table/tags/license/location + lightbox); `/about`; sidebar nav from ordering; OG tags on all (image = proxy feed rendition, A9); `.well-known/atproto-did` returns `env.OWNER_DID` as `text/plain`.
- [ ] **Step 4: Commit** — `feat(site): public portfolio pages with spec ordering rules and handle well-known`

### Task A9: Image proxy + blur-up

**Files:**
- Create: `apps/site/lib/image-proxy.ts`, `apps/site/app/img/[cid]/[preset]/route.ts`; Test: `apps/site/lib/image-proxy.test.ts`

- [ ] **Step 1: Port** `~/workspace/luminance.social/apps/web/lib/image-proxy.ts` + its route with these changes: allowlist = "cid appears among portfolio photograph records" (via `getPortfolio()`, cached — not a DB query); fetch **only** from `env.PDS_URL` (pinned; no DID resolution, no SSRF surface); blur data URIs stored in the SQLite `blur` table (A5 schema) instead of Postgres; presets `thumb 512 / grid 768 / feed 1024 / full 2048`, content negotiation and immutable caching identical.
- [ ] **Step 2: Port the test file**, adapting seeds to stubbed portfolio + SQLite; keep the 404-unknown-cid, 502-negative-cache, cross-format, and blur-population cases. Run → PASS.
- [ ] **Step 3: Wire** grid/detail `srcSet`/`sizes`/blur props exactly as luminance's `photo-grid.tsx`/detail page do today.
- [ ] **Step 4: Commit** — `feat(site): pinned-host image proxy with renditions and SQLite blur-up`

### Task A10: Export + backup scheduler

**Files:**
- Create: `apps/site/app/admin/export/route.ts` (streams `com.atproto.sync.getRepo?did=OWNER_DID` from the PDS as `portfolio-<date>.car`; owner-gated), `apps/site/lib/backup.ts`, wire into `apps/site/instrumentation.ts`
- Test: `apps/site/lib/backup.test.ts`

- [ ] **Step 1: Failing tests** — `runBackup(deps)` writes `${BACKUP_DIR}/car/<ISO-date>.car` from injected fetch stream + copies new blobs via `com.atproto.sync.listBlobs` paging → `${BACKUP_DIR}/blobs/<cid>` (skip existing); no `BACKUP_DIR` → no-op returning `{skipped:true}`; failures logged, never thrown.
- [ ] **Step 2: Implement + schedule** — `instrumentation.ts` registers a 24h `setInterval` (first run 60s after boot); no cron container (spec §5).
- [ ] **Step 3: Run tests** → PASS. **Step 4: Commit** — `feat(site): always-available CAR export and nightly self-scheduled backups`

### Task A11: Compose, caddy, setup.sh

**Files:**
- Create: `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/.env.example`, `deploy/setup.sh`, `apps/site/Dockerfile`

- [ ] **Step 1: Compose** —

```yaml
services:
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile", "caddy-data:/data"]
  pds:
    image: ghcr.io/bluesky-social/pds:0.4   # version-pinned; never modified
    environment:
      - PDS_HOSTNAME=pds.${DOMAIN}
      - PDS_BLOB_UPLOAD_LIMIT=33554432
      - PDS_ADMIN_PASSWORD=${PDS_ADMIN_PASSWORD}
      - PDS_JWT_SECRET=${PDS_JWT_SECRET}
      - PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=${PDS_ROTATION_KEY}
    volumes: ["pds-data:/pds"]
  app:
    build: { context: .., dockerfile: apps/site/Dockerfile }
    environment:
      - PDS_URL=https://pds.${DOMAIN}
      - PUBLIC_URL=https://${DOMAIN}
      - OWNER_DID=${OWNER_DID}
      - SESSION_SECRET=${SESSION_SECRET}
      - SQLITE_PATH=/data/app.db
      - BACKUP_DIR=/backups
    volumes: ["app-data:/data", "./backups:/backups"]
volumes: { caddy-data: {}, pds-data: {}, app-data: {} }
```

Caddyfile: `pds.{$DOMAIN} { reverse_proxy pds:3000 }` and `{$DOMAIN} { reverse_proxy app:3000 }`.

- [ ] **Step 2: `setup.sh`** — bash, `set -euo pipefail`, four phases exactly per spec §5: (1) **preflight**: `dig +short` apex and `pds.` both equal this host's public IP (from `curl -s ifconfig.me`), ports 80/443 free — on failure print the exact DNS record to create and exit 1; (2) `docker compose up -d` then poll `https://pds.${DOMAIN}/xrpc/_health`; create owner account via the PDS admin API (`POST /xrpc/com.atproto.server.createInviteCode` with admin auth, then `com.atproto.server.createAccount` with handle `${DOMAIN}`), write `OWNER_DID` into `.env`, `docker compose up -d app` (restart so the app reads it — the nit from spec review); (3) **recovery-key ceremony**: `goat key generate` → `goat account plc add-rotation-key --first <pubkey>` (prints did:key), save private key to `./recovery-key-KEEP-OFFLINE.txt`, print the store-offline + 72-hour-window explanation verbatim from spec §5; (4) `goat relay request-crawl --relay https://bsky.network https://pds.${DOMAIN}`.
- [ ] **Step 3: Verify** — `shellcheck deploy/setup.sh` clean; `docker compose config` valid. (Live execution happens in Part D on staging.)
- [ ] **Step 4: Commit** — `feat(deploy): compose (caddy+pinned PDS+app), preflight setup with recovery-key ceremony and relay crawl`

### Task A12: dev-env integration suite

**Files:**
- Create: `apps/site/integration/portfolio.dev-env.test.ts`, `apps/site/vitest.integration.config.ts`; add script `"test:integration": "vitest run --config vitest.integration.config.ts"`

- [ ] **Step 1: Port the harness pattern** from `~/workspace/luminance.social/apps/web/integration/social.dev-env.test.ts` (spins `@atproto/dev-env` TestNetwork, SQLite-native, no infra). Scenario: create account on dev PDS → run `publishPhotograph` (agent from dev-env creds, not OAuth) with a real JPEG buffer → `listAllRecords` sees the photograph → `saveCollection` referencing it → `getPortfolio()` (pointed at dev PDS via env override) returns ordered data → delete the photograph → `getPortfolio()` skips the dangling ref → `getRepo` CAR parses via `@atproto/repo`'s `readCar` and contains both record CIDs.
- [ ] **Step 2: Run** `pnpm --filter site test:integration` → PASS. **Step 3: Commit** — `test(site): dev-env integration — publish→render→dangling-ref→CAR round-trip`

### Task A13: Playwright E2E (author loop)

**Files:**
- Create: `apps/site/playwright.config.ts` (webServer: `next dev` with env pointing at a dev-env network booted in globalSetup), `apps/site/e2e/author-loop.spec.ts`, `apps/site/e2e/global-setup.ts`

- [ ] **Step 1: Spec** — scripted OAuth against dev-env's plain HTML login form (fill handle+password, submit, approve): sign in as owner → upload fixture JPEG via the dropzone input → assert prefilled title appears → publish → public `/` shows the tile → `/p/[rkey]` renders; sign in as a *different* dev-env account → `/admin` shows the not-owner rejection.
- [ ] **Step 2: Run** `pnpm --filter site exec playwright test` → PASS locally (not in CI — dev-env boot cost; CI addition is a productization item).
- [ ] **Step 3: Commit** — `test(site): E2E author loop incl. owner gate, against dev-env`

### Task A14: Runbooks

**Files:**
- Create: `docs/runbooks/{install.md, recovery-key.md, migrate-away.md, restore-from-backup.md, upgrade-pds.md}`

- [ ] **Step 1: Write all five** — install (DNS → setup.sh → first upload); recovery-key (ceremony, what the 72h window does and does not guarantee — spec §5 wording); migrate-away (goat: create account on target PDS → `goat account export` CAR → import → blob sync → `goat account plc sign`/submit endpoint update → verify handle+records — the runbook Part D executes against a scratch PDS); restore-from-backup (CAR + blobs → fresh PDS); upgrade-pds (pin bump procedure, flagship-first rule).
- [ ] **Step 2: Commit** — `docs: operator runbooks (install, recovery key, migrate-away, restore, upgrade)`

---

## Part B — Luminance adoption (repo `~/workspace/luminance.social`)

### Task B1: Migration 0006 — `photo_source` gains `opencontent`

**Files:**
- Modify: `packages/db/src/schema.ts` (pgEnum `photo_source` values + add `"opencontent"`); generated `packages/db/migrations/0006_*.sql`
- Test: `packages/db/src/schema-enum.test.ts`

- [ ] **Step 1:** Add the enum value in `schema.ts`; `pnpm --filter @luminance/db exec drizzle-kit generate --name opencontent_source`. Verify the generated SQL is **exactly one statement**: `ALTER TYPE "public"."photo_source" ADD VALUE 'opencontent';` — the transaction-trap mitigation is *isolation*: this migration contains nothing else, and no same-transaction usage exists (first use is runtime inserts long after commit). If drizzle bundles extra statements, hand-split the file.
- [ ] **Step 2: Failing test** — PGlite (real PG≥16 semantics): run migrations via `createTestDb()`, then `INSERT` a photos row with `source: "opencontent"` and read it back.
- [ ] **Step 3:** Run `pnpm --filter @luminance/db test` → PASS. Apply to production Neon **before merge** (the deploy-race rule proven in fast-follows): `DATABASE_URL=<unpooled> pnpm --filter @luminance/db exec drizzle-kit migrate`.
- [ ] **Step 4: Commit** — `feat(db): opencontent photo source (isolated single-statement enum migration)`

### Task B2: opencontent mappers + watched collections

**Files:**
- Create: `packages/atproto/src/mappers/opencontent.ts` + `opencontent.test.ts` (+ fixture records under `mappers/fixtures/`)
- Modify: `packages/atproto/src/index.ts` (exports), `packages/lexicons/src/index.ts` (add `OPENCONTENT_PHOTOGRAPH/COLLECTION` NSID constants), `apps/ingestor/src/backfill.ts` (WATCHED + `PHOTO_SOURCE_BY_COLLECTION["social.opencontent.photograph"] = "opencontent"` + reconcile branch for `.collection` mirroring the `social.grain.gallery` branch), `apps/ingestor/src/main.ts` (WANTED_COLLECTIONS), `apps/ingestor/src/indexer.ts` (route the two collections to the mappers, series path via the existing itemsAuthoritative handler)

**Interfaces:**
- Produces: `mapOpencontentPhotograph(ctx: Ctx, record: unknown): PhotoRow | null` (single image, mediaIndex 0, `aspectRatio`→width/height, selfLabels→labels, exif/tags/license/location through; malformed → null, never throw); `mapOpencontentCollection(ctx, record): { series: SeriesRow; itemUris: string[] } | null` (`items[].uri` order-preserved, `cover`→coverPhotoUri).

- [ ] **Step 1: Failing mapper tests** from fixtures (valid photograph; missing aspectRatio → null; labeled record → labels array; collection with 3 items order-preserved; dangling entries passed through as uris — hub joins skip them).
- [ ] **Step 2: Implement**, following `packages/atproto/src/mappers/bsky.ts` structure. Run → PASS.
- [ ] **Step 3: Ingestor wiring + reconciliation test** — extend `apps/ingestor/src/backfill.test.ts` with a walk over both new collections (create → reconcile deletes vanished). Run ingestor suite → PASS.
- [ ] **Step 4: Commit** — `feat(atproto+ingestor): index social.opencontent.photograph/.collection`

### Task B3: Retire `social.luminance.portfolio.*` + router seam

**Files:**
- Modify: `apps/ingestor/src/backfill.ts` + `main.ts` (drop LUMINANCE_PHOTO/SERIES from watched sets), `apps/web/lib/interactions.ts` (`routeInteraction`: explicit `case "opencontent": return { supported: false }` with the 3b comment), registration/settings copy mentioning sources
- Delete: `packages/atproto/src/mappers/luminance.ts` (+ its tests/fixtures), `packages/lexicons/lexicons/social/luminance/portfolio/*.json`
- Test: adjust `interactions.test.ts` router cases; full hub suites

- [ ] **Step 1:** Deletions + router case + copy. Keep `social.luminance.actor.profile` untouched (registration still uses it? — verify with `grep -rn LUMINANCE_PROFILE`; it remains watched for profile display and is NOT part of this retirement — only `portfolio.*` dies).
- [ ] **Step 2:** `pnpm typecheck && pnpm test` across db/atproto/ingestor/web → all green (expect compile errors to *find* every dangling reference; fix each).
- [ ] **Step 3:** Unpublish runbook note in `docs/runbooks/publish-lexicons.md`: delete the two `com.atproto.lexicon.schema` records for portfolio.* from the authority repo via goat; leave `_lexicon.portfolio.luminance.social` TXT to rot harmlessly or remove in Cloudflare.
- [ ] **Step 4: Commit** — `feat: retire social.luminance.portfolio.* (zero records existed); explicit opencontent interactions seam`

---

## Part C — Commons publication (after gate G0)

### Task C1: Governance repo + publish

**Files:**
- Create: repo `iserlabs/opencontent-lexicons` — `lexicons/` (the three JSONs, **copied from A2 — this repo is the source of truth going forward**), `GOVERNANCE.md` (BDFL, PRs welcome, additive-only, breaking = new NSID, domain-transfer exit), `LICENSE` (MIT), `README.md` (consumer rules from spec §3 verbatim: dangling refs, unknown fields, unlisted-collection ordering)

- [ ] **Step 1:** Create + push. **Step 2:** Cross-check hub display contract: exif `fNumber` string tolerated by `apps/web` EXIF rendering (it renders string|number — verify by reading the EXIF_FIELDS map on the photo page). **Step 3: Commit/push.**

### Task C2: Steward account + goat publish

Runbook execution (human+agent pairing, after staging PDS exists in D1):

- [ ] Create steward account on flagship PDS (`setup.sh`-style admin API call), handle `@opencontent.social`; Kevin adds `_atproto.opencontent.social` TXT → steward DID; verify handle resolves.
- [ ] Publish the three schemas: `goat lex publish` (per `docs/runbooks/publish-lexicons.md` in luminance repo — same pipeline); Kevin adds `_lexicon.opencontent.social` TXT → steward DID.
- [ ] Verify from a clean machine: `goat lex resolve social.opencontent.photograph` succeeds (acceptance criterion 4).

---

## Part D — Flagship (after gate G1)

### Task D1: Staging deployment

- [ ] Run `deploy/setup.sh` on the staging VPS with the scratch hostname pair — preflight through relay crawl, recovery-key file produced. Fix whatever reality breaks; every fix lands as a commit to Part A files.
- [ ] Kevin uploads 3+ real photographs through admin; verify public site, lightbox, OG tags, `.well-known`.
- [ ] Execute `migrate-away.md` against a scratch second PDS (acceptance criterion 5); execute `restore-from-backup.md` once.
- [ ] Register the staging account on luminance.social (standard OAuth flow); verify photographs appear with source `opencontent` within ~1 min; verify the interactions row renders the "arrives with portfolio publishing" copy.

### Task D2: klee.photos production + acceptance

- [ ] Fresh VPS (or promote staging), real domain: Kevin creates DNS (`klee.photos` apex + `pds.klee.photos`, grey-cloud) at cutover moment (gate G2); run setup.sh; account handle `@klee.photos`; recovery-key ceremony completed and key handed to Kevin (criterion 6).
- [ ] Kevin builds out the portfolio (uploads + collections mirroring Street/Urban/…); site config nav order set.
- [ ] Bluesky visibility: post once from the new account; visible at bsky.app (criterion 2).
- [ ] Register on Luminance; verify criterion 3 end-to-end.
- [ ] Lighthouse: `npx lighthouse https://klee.photos --preset=desktop` and mobile default — both ≥90, CLS 0 (criterion 8); fix regressions before calling done.
- [ ] Walk all 8 acceptance criteria from spec §7; record results in `docs/TODO.md`; old account remains until Kevin's explicit parity call (criterion 7).

---

## Execution order & checkpoints

A1→A2→A3→A4→A5→A6→A7→A8→A9→A10→A11→A12→A13→A14 (framework complete, all tests green) ‖ B1→B2→B3 can run in parallel with Part A after A2 exists (B2 needs the schema fixtures). C1→C2 after G0+D1's PDS. D1→D2 after G1/G2. Checkpoints: end of Part A (framework passes unit+integration+E2E), end of Part B (hub green + deployed), end of D1 (staging acceptance), end of D2 (launch).
