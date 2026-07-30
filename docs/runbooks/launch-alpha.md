# Runbook: Alpha launch checklist

> **Status (2026-07-30):** executed in full 2026-07-22 — the alpha is live
> (see `docs/TODO.md` §1 for the as-run record, including launch-day
> incidents). Kept as the reference procedure for re-provisioning, disaster
> recovery, or standing up a second environment; facts below are updated to
> the current state of the repo.

Ordered, top-to-bottom checklist for taking `feature/foundation` from merged
code to a live `luminance.social` alpha with real registered photographers.
Work through it in order — later steps assume earlier ones are done (e.g. the
OAuth smoke test needs env vars from step 2, and criterion 2 needs the ingestor
from step 3 already running).

- [ ] 1. Neon production database + migrations
- [ ] 2. Vercel project + environment variables
- [ ] 3. Fly app + secrets + first deploy
- [ ] 4. DNS for luminance.social
- [ ] 5. Lexicon DNS + publishing (separate runbook)
- [ ] 6. OAuth smoke test with a real bsky.social account
- [ ] 7. Register Kevin's account
- [ ] 8. Success criterion 2 — Bluesky post appears in feed within 60s
- [ ] 9. Success criterion 3 — rebuild drill (already automated)
- [ ] 10. Success criterion 4 — Lighthouse ≥ 90

---

## 1. Neon production database + migrations

1. Create a Neon project (<https://console.neon.tech>) for `luminance-social`
   production. Copy the **pooled** connection string (Neon's "Connect" panel,
   `postgres://...`) — this is `DATABASE_URL`, and it's shared by both apps
   (web and ingestor both write to the same index/app-state DB, per the
   architecture in `docs/superpowers/specs/2026-07-21-luminance-foundation-design.md` §6).

2. Run migrations from the repo root:

   ```bash
   DATABASE_URL="<neon-connection-string>" pnpm --filter @openphotos/db exec drizzle-kit migrate
   ```

   This applies everything under `packages/db/migrations/` — `0000`–`0006` as
   of 2026-07-30 (config: `packages/db/drizzle.config.ts`, schema
   `packages/db/src/schema.ts`).

3. Verify: connect with `psql "$DATABASE_URL"` and confirm the tables exist —
   `photographers`, `photo_overrides`, `oauth_states`, `oauth_sessions`,
   `ingest_cursors`, `tombstones`, `photos`, `series`, `series_photos`, plus
   the phase-2/3 additions `interactions`, `engagement`, `notifications`,
   `admin_audit` (`\dt` should match the tables in `schema.ts`).

4. **Backup note (no action needed):** Neon's point-in-time recovery is a
   project-level setting, on by default, and it's what backs up the durable
   app-state tables (`photographers`, `photo_overrides`, `oauth_states`,
   `oauth_sessions`, `ingest_cursors`). The index tables (`photos`, `series`,
   `series_photos`, `tombstones`) intentionally need no backup — they're
   rebuildable from source PDS data by design (see step 9). Nothing to
   configure beyond leaving Neon's default retention in place.

## 2. Vercel project + environment variables

1. Import the repo into a new Vercel project with **Root Directory** set to
   `apps/web` (how the live `luminance-social` project is configured).
   `apps/web/vercel.json` sets the build command to
   `cd ../.. && pnpm --filter web... build`, hopping back to the monorepo root
   so pnpm can resolve `@openphotos/db`, `@openphotos/atproto`,
   `@openphotos/lexicons` from the workspace.

2. Set every variable from `apps/web/.env.example` in Project Settings →
   Environment Variables (Production, and Preview if you want preview
   deployments to run against real data):

   | Variable | Where to get it |
   |---|---|
   | `DATABASE_URL` | The same Neon pooled connection string from step 1. |
   | `PUBLIC_URL` | `https://luminance.social` for Production. For Preview deployments, Vercel's own generated preview URL works too (see step 6 — OAuth needs *some* public https origin, not necessarily the final domain). |
   | `SESSION_SECRET` | Generate locally: `openssl rand -hex 32`. Paste the output in — do not reuse the dev value from `.env.local`. |
   | `ADMIN_DIDS` | Leave blank for now; fill in after step 7 once Kevin's DID is known (comma-separated DIDs, no spaces). |
   | `SENTRY_DSN` | Optional. From a Sentry project's Settings → Client Keys (DSN), if you want error reporting; leave blank to disable (`apps/web/instrumentation.ts` no-ops with no DSN). |
   | `OAUTH_JWK_1` | Generate a **production** key — do not reuse any `.env.local` dev key. Command below. Paste the single-line JSON output; treat it as a secret (it's a private signing key) — Vercel env vars are the secret manager here. |

   `OAUTH_JWK_1` generation command (same one-liner documented in
   `apps/web/.env.example`, run it fresh for production):

   ```bash
   node --input-type=module -e 'import {JoseKey} from "@atproto/jwk-jose"; import {randomUUID} from "node:crypto"; const k=await JoseKey.generate(["ES256"], `openphotos-${randomUUID()}`); console.log(JSON.stringify({...k.privateJwk, alg:"ES256"}))'
   ```

3. Trigger a deploy (push to `main`, or `vercel --prod` from the CLI). Confirm
   the build succeeds and `/` loads.

## 3. Fly app + secrets + first deploy

The ingestor (`apps/ingestor`) is a long-running Jetstream consumer, deployed
to Fly (`apps/ingestor/fly.toml`, app name `luminance-ingestor`).

1. Auth:

   ```bash
   fly auth login
   ```

2. Create the app (name must match `app = "luminance-ingestor"` in
   `apps/ingestor/fly.toml`):

   ```bash
   fly apps create --name luminance-ingestor --org <your-fly-org>
   ```

3. Set secrets. Only `DATABASE_URL` is strictly required —
   `apps/ingestor/src/config.ts` throws at startup if it's missing.
   `JETSTREAM_URL` already defaults to `wss://jetstream2.us-east.bsky.network`
   and only needs setting if you want a different Jetstream instance.
   `SENTRY_DSN` is optional (`apps/ingestor/src/sentry.ts` no-ops without it):

   ```bash
   fly secrets set --config apps/ingestor/fly.toml \
     DATABASE_URL="<same neon connection string as step 1>" \
     SENTRY_DSN="<optional sentry dsn>"
   ```

4. First deploy, run from the **repo root** (the Dockerfile's build context
   must be the monorepo root so pnpm/turbo can resolve the workspace
   packages — see the comment at the top of `apps/ingestor/Dockerfile`). Same
   invocation `.github/workflows/deploy-ingestor.yml` uses (CI adds
   `--remote-only`):

   ```bash
   fly deploy --config apps/ingestor/fly.toml --dockerfile apps/ingestor/Dockerfile
   ```

5. Verify:

   ```bash
   curl https://luminance-ingestor.fly.dev/health
   # -> {"ok":true,"stats":{"indexed":0,"skipped":0,"deleted":0}}
   fly logs --config apps/ingestor/fly.toml
   ```

   `min_machines_running = 1` and `auto_stop_machines = false` in `fly.toml`
   keep one machine always up — expected, this is a websocket consumer, not a
   request-driven service that should scale to zero.

6. For subsequent deploys to happen automatically after a **green CI run on
   `main`** (the workflow is `workflow_run`-gated on `ci`, not fired directly
   on push), add
   `FLY_API_TOKEN` (from `fly tokens create deploy --config apps/ingestor/fly.toml`,
   or the Fly dashboard) as a GitHub Actions repo secret — the existing
   `.github/workflows/deploy-ingestor.yml` workflow already reads it and only
   needs the secret to exist.

## 4. DNS for luminance.social

1. In the Vercel project → Settings → Domains, add `luminance.social` (and
   `www.luminance.social` if desired) and follow Vercel's shown instructions
   (typically an `A`/`ALIAS` record for the apex and a `CNAME` for `www`, at
   whatever registrar/DNS host manages `luminance.social`).
2. Wait for DNS propagation and Vercel's automatic TLS certificate to issue.
3. Confirm `https://luminance.social/` serves the app.

The ingestor does **not** need a `luminance.social` DNS entry — it's reached
only via its own `luminance-ingestor.fly.dev` domain for health checks; it
serves no public user traffic.

## 5. Lexicon DNS + publishing

Separate concern, separate runbook: `docs/runbooks/publish-lexicons.md`. Do
this once `luminance.social` DNS (step 4) is under your control, since it
adds a TXT record (`_lexicon.actor.luminance.social`; the former
`_lexicon.portfolio.luminance.social` authority was retired with
`social.luminance.portfolio.*` on 2026-07-28) at the same DNS host. Not required for
the app itself to function — the `social.luminance.*` lexicons are consumed
directly from the JSON files via `@openphotos/lexicons` — but required for the
NSIDs to resolve for anyone (or anything) else on the network.

## 6. OAuth smoke test with a real bsky.social account

ATProto OAuth requires a public **https** origin — the authorization server
fetches `PUBLIC_URL/oauth/client-metadata.json` and `PUBLIC_URL/oauth/jwks.json`
(built in `apps/web/lib/oauth.ts`) over https, and the callback
(`PUBLIC_URL/oauth/callback`) must be reachable the same way. A **Vercel
preview deployment already satisfies this** — each preview gets its own https
URL — so this smoke test can run before step 4's DNS cutover, as long as
`PUBLIC_URL` for that deployment matches the URL you're actually hitting
(preview URLs are unique per-deployment, so this generally means testing
against the Production deployment once `PUBLIC_URL=https://luminance.social`
is set, or temporarily overriding `PUBLIC_URL` for one preview build).

1. Open `<PUBLIC_URL>/register`.
2. Enter a real `*.bsky.social` handle, submit (`startLogin` in
   `apps/web/app/register/actions.ts`) — this redirects to that account's PDS
   authorization screen.
3. Log in and authorize on the PDS's own page.
4. Confirm redirect back to `<PUBLIC_URL>/oauth/callback` and then to
   `/register/sources` with no `?error=` query param.
5. Pick source toggles, submit, confirm landing on `/register/status` with no
   error.

If it fails: check `?error=` on `/register` (`handle`/`login`/`oauth`/`session`
in `apps/web/app/register/page.tsx`) and Vercel function logs for the
`/oauth/callback` route.

## 7. Register Kevin's account

Same flow as step 6, using Kevin's own `bsky.social` (or other ATProto PDS)
account. After completing it:

1. Find Kevin's DID — visible in the callback session, or resolve his handle:
   `curl -s "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=<kevin's-handle>" | jq -r .did`.
2. Add that DID to the `ADMIN_DIDS` Vercel env var (step 2) if Kevin should
   have admin/takedown access (`apps/web/lib/session.ts` `isAdminDid`,
   surfaced on `/settings`). Redeploy for the env var change to take effect.
3. Register at least two photographer friends with existing ATProto accounts
   the same way (success criterion 1: "Kevin + at least two photographer
   friends... registered and visible in the hub").

## 8. Success criterion 2 — Bluesky post appears in feed within 60s

> "A photo posted on Bluesky appears in the hub feed within 60 seconds"

1. Confirm the registered account has `includeBsky` on (default `true`;
   toggle at `/settings` if needed).
2. From that account, post a new Bluesky post **with an image attached** (top-
   level post, not a reply — replies are intentionally skipped, per spec §7).
3. Start a timer, then watch for it to appear:
   - `https://luminance.social/` (feed), or
   - `https://luminance.social/<handle>` (their profile grid), or
   - poll the JSON feed API directly, filtered to that DID:
     `curl -s "https://luminance.social/api/feed?did=<their-did>&limit=1" | jq`
4. Should appear well under 60s. If it doesn't: check ingestor logs
   (`fly logs --config apps/ingestor/fly.toml`) for Jetstream connection
   state and `cursor_lag_seconds` (alert threshold 300s, logged every 60s per
   `apps/ingestor/src/main.ts`), and confirm the DID is in the ingestor's
   registered-photographers poll (`getDids` in the same file).

## 9. Success criterion 3 — rebuild drill (already automated)

> "Full index drop + rebuild drill converges to identical feed output"

No manual steps — this is `apps/ingestor/src/integration/dev-env.test.ts`,
run via:

```bash
pnpm --filter ingestor test:integration
```

Per `apps/ingestor/README.md`: it spins up a real local PDS with
`@atproto/dev-env` (SQLite-native, no Docker/Postgres needed), writes real
photo records, backfills them over HTTP, exercises a live delete, then drops
the index and rebuilds it to convergence. It's excluded from the default
`pnpm test` / CI run (see `apps/ingestor/vitest.config.ts`) because it's slow
and network-y; run it explicitly as a launch gate. If it fails with "Could not
locate the bindings file", run `pnpm rebuild -r better-sqlite3` first.

## 10. Success criterion 4 — Lighthouse ≥ 90

> "Lighthouse ≥ 90 on feed and photo pages on mobile"

Run against the live production URLs (mobile preset), not localhost — real
network/CDN/image-proxy behavior matters here.

```bash
npx lighthouse https://luminance.social/ --preset=mobile --view
npx lighthouse "https://luminance.social/photo/<did>/<collection>/<rkey>" --preset=mobile --view
```

Pick a real photo's URL for the second run — the route triple is the AT-URI
(`did`, `collection` e.g. `app.bsky.feed.post` or
`social.opencontent.photograph`, `rkey`); copy one from `/api/feed` output or from a
profile grid link. Chrome DevTools' Lighthouse panel or
<https://pagespeed.web.dev/> work equally well if you'd rather not use the CLI.

Target ≥ 90 on both pages. If short: check image proxy presets are actually
being served (`/img/[did]/[cid]/[preset]`, `thumb`/`feed`/`full`) rather than
full-size originals, and that `aspectRatio` is present on photo records (it
reserves layout space and avoids CLS — spec §10).

## Verifying the social layer

Manual acceptance checklist for the phase-2 social layer — criteria 1–3 from the
design spec (`docs/superpowers/specs/2026-07-22-social-layer-design.md` §11).
Run these on the live site once at least one photographer is registered and has
a Bluesky-sourced photo in the feed. You need two ATProto accounts: the
**photographer** (registered on OpenPhotos) and a **viewer** (any bsky account).
The automated write-path proof for the same flow is
`apps/web/integration/social.dev-env.test.ts`
(`pnpm --filter web test:integration`) — this checklist confirms it against real
Bluesky + real accounts end-to-end.

- [ ] **Criterion 1 — like interop reaches Bluesky.** Sign in on OpenPhotos as the
  viewer (`/login`), open one of the photographer's photo pages, and click Like.
  Then open the **photographer's Bluesky notifications** (bsky.app or the app) and
  confirm the like appears there — it is a real `app.bsky.feed.like` in the
  viewer's repo, so Bluesky's own AppView surfaces it. Confirm the like count on
  the OpenPhotos photo page ticked up and did not regress on refresh.
- [ ] **Criterion 2 — comments render both directions.** Still signed in as the
  viewer, post a comment on the same OpenPhotos photo. (a) **OpenPhotos → Bluesky:**
  open the underlying post in the Bluesky app ("View on Bluesky" link on the photo
  page) and confirm the comment shows in that post's thread. (b) **Bluesky →
  OpenPhotos:** from the Bluesky app, reply to the same post; within the photo
  page's 60s thread cache (hard-refresh to force it) confirm that reply renders in
  the OpenPhotos comment thread.
- [ ] **Criterion 3 — non-OpenPhotos like reaches `/notifications` within a sweep +
  1 min.** From a Bluesky account that is **not** signed in to OpenPhotos, like the
  photographer's underlying Bluesky post directly in the Bluesky app. Note the
  time. Sign in to OpenPhotos as the photographer and watch `/notifications`: the
  like should appear within one engagement-sweep interval + ~1 min (the sweep is
  what pulls externally-originated likes into the notification center; see the
  engagement sweep in `apps/ingestor`). If it does not, check the ingestor logs
  for the sweep tick and confirm the photographer's posts are within the swept
  set.
