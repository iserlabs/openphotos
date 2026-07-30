# Luminance.social — Social Layer Design (Phase 2)

**Date:** 2026-07-22
**Status:** Draft for review
**Builds on:** `2026-07-21-luminance-foundation-design.md` (Foundation, shipped + launched 2026-07-22)

---

## 1. Product decisions (locked this phase)

| Decision | Choice |
|---|---|
| Interaction lexicons | **Source-native hybrid**: interactions are written in the photo's source's lexicon. Bluesky-source photos (100% of today's content) get real `app.bsky.feed.like` / reply posts / `app.bsky.graph.follow` records; Luminance-source photos get `social.luminance.feedback.*` when phase 3 makes them real. One router, keyed on `photo.source`, with an explicit unsupported branch until then. |
| Feature scope | **Full suite**: likes, comments (threaded, incl. pre-existing Bluesky replies), follows, and an in-hub notification center. |
| Who can interact | **Any ATProto user** — viewer sign-in (session, no photographer row). Interacting ≠ registering. |
| Engagement reads | **Write-through + AppView hydration** (Approach 3): interactions made via Luminance are recorded locally in the same request; everything from the wider network is hydrated from Bluesky's public AppView. **No network-wide firehose indexing** — the 2026-07-22 Jetstream-lag incident (their instances missing a PDS's events for 30+ min while Bluesky's own AppView indexed in 52s) demonstrated the firehose is best-effort delivery; for stranger engagement there is no reconciliation path, so we read from the indexer that Bluesky already reconciles. |

Rationale for source-native: photographers feel every like/comment in the Bluesky
notifications they already check; threads are shared both directions; photos carry
their existing network engagement from day one. The known cost — two code paths
once phase 3 lands — is bounded and bought deliberately.

## 2. Architecture

No new deployables. Four grown components:

- **`packages/atproto`**: `interaction-records.ts` (pure builders: like, reply
  with correct root/parent strong refs, follow) and `appview.ts` (client for
  `public.api.bsky.app`: `getPosts`, `getPostThread`, `getLikes`,
  `getFollowers`, `getProfile` — unauthenticated, through `safeFetch`).
- **`packages/db`**: three new tables (§3).
- **`apps/web`**: viewer sign-in (`/login`), interaction server actions,
  photo-page threads + like buttons, tile counts, `/notifications` + header
  bell.
- **`apps/ingestor`**: the engagement sweep (§5) — periodic, bounded to
  registered photographers' content, never the network.

The **interaction router** is one function: `photo.source === "bsky"` →
Bluesky records against the underlying post; `luminance`/`grain` → explicit
`{ supported: false }` that the UI renders as a disabled row ("interactions
arrive with portfolio publishing"). Phase 3 fills the branch.

## 3. Data model

**`interactions`** *(durable — write-through log of interactions made via Luminance)*
- PK `record_uri` (the interaction record's AT-URI in the actor's repo),
  `actor_did`, `kind` (`like | comment | follow`), `subject_uri` (post AT-URI
  for like/comment; photographer DID for follow), `text` (comments), `record_cid`,
  `created_at`, **`deleted_at` nullable (soft delete)**.
- Index `(actor_did, kind, subject_uri)` — unlike/unfollow lookup and button state.
- Soft delete is load-bearing: the count formula (§4) needs unlike *events*;
  rows are pruned by the sweep once `engagement.fetched_at > deleted_at`.

**`engagement`** *(rebuildable cache)*
- PK `post_uri`, `like_count`, `reply_count`, `repost_count` (stored, display
  deferred), `fetched_at`.
- Never hand-bumped. Sweep-written only.

**`notifications`** *(durable)*
- `id`, `recipient_did`, `actor_did`, `actor_handle`, `actor_avatar_url`
  (denormalized snapshot; Bluesky CDN URL — see §5 avatar exception), `kind`,
  `subject_uri` (dedupe identity: post URI for likes, reply URI for comments,
  recipient DID for follows), **`link_uri` (navigation target — always the
  photo's AT-URI, or the profile for follows)**, `snippet`, `created_at`,
  `read_at` nullable.
- **Unique `(kind, subject_uri, actor_did, recipient_did)`** + upsert-do-nothing
  → at-least-once sweeps are idempotent by construction.
- Scope: recipients are registered photographers only. A viewer whose comment
  gets a reply hears about it from Bluesky (conscious cut; revisit in phase 3
  when Luminance-lexicon interactions exist that Bluesky cannot deliver).

**Displayed count formula** (the race fix): displayed = `engagement.like_count`
\+ local likes with `created_at > fetched_at` − local unlikes with
`deleted_at > fetched_at` (same for replies). Self-correcting: once the sweep's
`fetched_at` passes an interaction, the AppView count has absorbed it and its
delta term drops out. Feed hydration computes deltas in **one grouped query**
joined to the feed page — never per-tile.

Counts are per-post: every tile of a multi-image post shows the same number, by design.

## 4. Write path

**Viewer sign-in:** header "Sign in" → `/login` → same OAuth client with
`mode=viewer` and a same-origin-validated relative `returnTo` carried in OAuth
state → callback forks on mode: viewer gets session `{did, handle}`, no
photographer row, redirect to `returnTo`. ⚠ The custom-state round-trip through
`@atproto/oauth-client-node` is **verify-against-installed-API** at
implementation time (Task-13 discipline).

**Actions** (server actions; session re-checked; router-dispatched; per-session
rate limit **30 interaction writes / 5 min** via a windowed count over
`interactions` including soft-deleted rows):

- **Like:** create `app.bsky.feed.like` (subject = post `uri`+`cid`) in the
  viewer's repo via their OAuth agent, then write-through: `interactions` row +
  `notifications` row (if the photographer is registered and ≠ actor). Record
  first, DB second — a failed DB half self-heals via the sweep. **Unlike:**
  soft-delete via stored `record_uri` + `deleteRecord`. Missing row fallback:
  scan the viewer's own likes collection, **capped at 10 pages**, then fail
  gracefully ("unlike in your Bluesky app").
- **Comment:** text 1–300 graphemes (the `app.bsky.feed.post` lexicon cap — a comment IS a reply post; the composer enforces and shows the limit) → real Bluesky reply (`root` = the post;
  `parent` = the post or the comment being replied to). Same write-through +
  notification with snippet. **Delete-own-comment** supported (same reversal
  path as unlike).
- **Follow:** `app.bsky.graph.follow` (subject = photographer DID) from the
  profile page; unfollow via stored record URI. Button state from the viewer's
  authed `getProfile` (their PDS proxies it).

Every record written is owned by the user, in their repo. Luminance stores
session references, never credentials.

## 5. Engagement sweep (ingestor)

Every 3 minutes (base): registered-active photographers' bsky-source post URIs
→ `getPosts` batches of 25 → upsert `engagement` with `fetched_at = now`.
Where a count rose: likes → one `getLikes` page (newest 100) → notification
upserts; replies → `getPostThread` → notification upsert per unseen reply URI.
**Follower diff runs every 5th sweep** (least time-sensitive kind). Serialized
batches; 429 aborts the tick with backoff — per-photo upserts are independent,
next tick resumes. Prunes absorbed soft-deleted `interactions`.

- **Scale governor:** sweep interval stretches with registry size to stay under
  ~40% of the public AppView's rate budget (~3000 req/5min); the computed
  interval is logged. Alpha scale (≤100 photographers) holds the 3-min base.
- **Staleness alert:** oldest `fetched_at` > 30 min → error log + Sentry (same
  pattern as cursor lag).
- **Known cut:** >100 likes on one photo between sweeps notifies only the
  newest 100 actors; counts stay correct.

**Avatar exception (explicit):** notification rows and comment threads display
*network actors'* avatars from Bluesky's CDN URLs as returned by the AppView.
The Foundation's image-proxy allowlist rule is untouched — it governs PDS blob
fetching for indexed photo content; actor avatars are source-native display of
source-native actors.

## 6. Notification center

Header bell for photographer sessions only; badge = server-rendered unread
count. `/notifications` (dotless ✓): 50/page keyset; row = actor avatar +
handle, verb, snippet, relative time, deep link via `link_uri` (photo page
anchor / profile). **Mark-read fires from a client component after mount** —
never during server render (Next link-prefetch would otherwise mark everything
read on hover). "Mark all read" action for the badge-only case.

## 7. Page surfaces

- **Feed tiles:** understated like/comment counts; the photograph stays the point.
- **Photo page:** like button (filled = write-through state; a like made in the
  Bluesky app appears in the count but not the button — honest seam,
  documented), hydrated thread (60s cache; 2 levels deep, then "continue this
  thread on Bluesky"), composer or "Sign in to comment", delete-own-comment.
- **Thread moderation inherits Bluesky's:** labeled reply content/authors render
  behind the standard blur-gate; blocked/hidden-reply stubs render as absent.
  Photographers moderate in Bluesky (hide reply, block) — reflected here
  automatically. No parallel comment-moderation surface in phase 2.
- **Profile page:** Follow button + follower count (5-min revalidate).
- **Header:** Sign in / avatar menu (viewer: sign out; photographer: settings +
  bell).
- **Non-bsky-source photos:** disabled interaction row with the phase-3 note.

## 8. Error handling

Write failures surface inline at the control; expired sessions prompt re-auth
preserving `returnTo`. AppView outage: counts serve stale silently, threads
degrade to "comments temporarily unavailable" — the site never blocks on
Bluesky. All notification writes upsert-do-nothing. Sweep ticks are
independently resumable.

## 9. Testing

- **Unit (deep end):** record builders (reply root/parent chains), router incl.
  unsupported sources, **count formula under every race permutation**
  (like-before-sweep; unlike-of-absorbed-like; like+unlike both pending),
  notification diffing against fixtures captured from the real AppView API,
  rate-limit window math, mark-read mount semantics (action-level).
- **Integration (dev-env):** real PDS — like/reply/follow written through the
  actual helpers (password session), records verified in-repo + write-through
  rows; unlike and delete-comment round-trips.
- **Sweep integration:** mock AppView server with real-shaped fixtures; two
  consecutive sweeps prove notification idempotence.
- **E2E (Playwright — starts the long-deferred suite):** photo-page thread
  render; signed-out → signed-in composer gate. Run locally/pre-release;
  CI wiring optional this phase.

## 10. Out of scope (phase 2)

Luminance-lexicon interactions (phase 3 fills the router branch), viewer
notifications, repost display, in-hub comment moderation tools, live/websocket
notification updates, structured critique semantics, Grain-lexicon interaction
writes (`social.grain.favorite` — revisit with phase 3's grain posture).

## 11. Success criteria

1. A signed-in viewer's like on a Luminance photo appears in the photographer's
   **Bluesky notifications** (interop proven end-to-end).
2. A comment posted on Luminance renders in the Bluesky app's thread, and a
   Bluesky reply renders on Luminance's photo page (both directions).
3. A like from a *non-Luminance* user reaches the photographer's Luminance
   notification center within one sweep interval + 1 min.
4. Displayed counts never regress after a local interaction (race formula
   holds under manual adversarial testing).
5. All Foundation success criteria still hold (no regression).
