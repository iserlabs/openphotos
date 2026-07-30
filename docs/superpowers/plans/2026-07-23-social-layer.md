# Social Layer (Phase 2) Implementation Plan

> **Status as of 2026-07-30: SHIPPED.** Built on `feature/social-layer` and
> merged 2026-07-25 (likes/comments/follows, notifications, engagement sweep),
> plus a fast-follow wave the same week. The checkboxes below were never
> maintained during execution — git history and `docs/TODO.md` are
> authoritative.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Likes, comments, follows, and a notification center for luminance.social — written as real Bluesky records in the viewer's own repo (source-native, spec option C), with engagement read via write-through + Bluesky AppView hydration.

**Architecture:** No new deployables. `packages/atproto` gains record builders + an AppView client; `packages/db` gains `interactions`/`engagement`/`notifications`; `apps/web` gains viewer sign-in, interaction server actions, thread/count surfaces, `/notifications`; `apps/ingestor` gains the engagement sweep. No network-wide firehose indexing (spec §1: 2026-07-22 Jetstream-lag incident).

**Tech Stack:** existing workspace (TypeScript strict/NodeNext, Drizzle+Neon/PGlite, Next.js 16 App Router, `@atproto/api` + `@atproto/oauth-client-node`, Vitest). Spec: `docs/superpowers/specs/2026-07-22-social-layer-design.md`.

## Global Constraints

- Interactions router: `photo.source === "bsky"` → real Bluesky records; `luminance`/`grain` → `{ supported: false }` (UI: disabled row "Interactions arrive with portfolio publishing"). Spec §2.
- Write order: PDS record FIRST, DB write-through SECOND (sweep self-heals a failed DB half). Spec §4.
- Rate limit: **30 interaction writes / 5 min** per actor, windowed count over `interactions` INCLUDING soft-deleted. Spec §4.
- Comment text: **1–300 graphemes** (`app.bsky.feed.post` cap). Spec §4.
- Unlike fallback repo scan: **cap 10 pages**, then graceful failure. Spec §4.
- `engagement` is sweep-written ONLY (never hand-bumped). Displayed count = `engagement.count` + local creates newer than `fetched_at` − local soft-deletes newer than `fetched_at`, computed as ONE grouped query for feed pages. Spec §3.
- Counts are per-post; every tile of a multi-image post shows the same number. Spec §3.
- `notifications` unique `(kind, subject_uri, actor_did, recipient_did)`, upsert-do-nothing; recipients = registered photographers only; `link_uri` is the navigation target (photo AT-URI; profile path for follows). Spec §3.
- Mark-read fires from a client component AFTER MOUNT — never during server render (Next link-prefetch hazard). Spec §6.
- Sweep: 3-min base interval; follower diff every 5th sweep; 429 aborts tick with backoff; interval stretches to stay ≤40% of ~3000 req/5min; staleness alert when oldest `fetched_at` > 30 min; prunes soft-deleted interactions once `fetched_at > deleted_at`. Spec §5.
- Actor avatars (notifications, comment threads) render from Bluesky CDN URLs returned by the AppView — explicit exception; the image-proxy allowlist rule is untouched. Spec §5.
- Thread moderation inherits Bluesky's: labeled reply content/authors behind the standard blur-gate; blocked/hidden stubs render as absent. No parallel moderation surface. Spec §7.
- All new top-level routes dotless (`/login`, `/notifications`). Foundation invariant.
- Zero-env build must keep passing (lazy env access only). OAuth custom-state round-trip is verify-against-installed-API (`@atproto/oauth-client-node@0.4.x`) — adapt and document deviations.
- Env var names (exact): no new required env vars in this phase.

---

### Task 1: Data model — interactions, engagement, notifications (+ count helpers)

**Files:**
- Modify: `packages/db/src/schema.ts` (append three tables)
- Create: `packages/db/src/social.ts`, `packages/db/src/social.test.ts`
- Modify: `packages/db/src/index.ts` (add `export * from "./social.js";`)
- Migration: generated `packages/db/migrations/0002_social_layer.sql`

**Interfaces:**
- Consumes: existing schema patterns (`pgTable`, composite PKs), `createTestDb`.
- Produces: tables `interactions`, `engagement`, `notifications`; types via `$infer*`; `engagementFor(db, postUris: string[]): Promise<Map<string, { likeCount: number; replyCount: number }>>` (AppView counts + write-through deltas, one grouped query batch); `recordInteraction(db, row)`, `softDeleteInteraction(db, recordUri)`, `findInteraction(db, actorDid, kind, subjectUri)` (excludes soft-deleted), `interactionWritesInWindow(db, actorDid, windowMs): Promise<number>` (INCLUDES soft-deleted), `pushNotification(db, row)` (upsert-do-nothing), `unreadCount(db, recipientDid)`, `notificationsPage(db, recipientDid, { limit, cursor })`, `markAllRead(db, recipientDid)`, `markRead(db, recipientDid, ids: number[])`.

- [ ] **Step 1: Schema.** Append to `packages/db/src/schema.ts` (import `bigserial` if needed — use `serial` int is fine at this scale; use existing imports style):

```ts
export const interactionKind = pgEnum("interaction_kind", ["like", "comment", "follow"]);

// ---- durable app state (phase 2) ----
export const interactions = pgTable("interactions", {
  recordUri: text("record_uri").primaryKey(), // the record in the ACTOR's repo
  actorDid: text("actor_did").notNull(),
  kind: interactionKind("kind").notNull(),
  subjectUri: text("subject_uri").notNull(), // post at-uri (like/comment) | photographer did (follow)
  text: text("text"),
  recordCid: text("record_cid"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete — count formula needs unlike EVENTS (spec §3)
}, (t) => [index("interactions_lookup_idx").on(t.actorDid, t.kind, t.subjectUri), index("interactions_subject_idx").on(t.subjectUri)]);

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  recipientDid: text("recipient_did").notNull(),
  actorDid: text("actor_did").notNull(),
  actorHandle: text("actor_handle").notNull(),
  actorAvatarUrl: text("actor_avatar_url"),
  kind: interactionKind("kind").notNull(),
  subjectUri: text("subject_uri").notNull(), // dedupe identity (spec §3)
  linkUri: text("link_uri").notNull(),       // navigation target (spec §3)
  snippet: text("snippet"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("notifications_dedupe_idx").on(t.kind, t.subjectUri, t.actorDid, t.recipientDid),
  index("notifications_recipient_idx").on(t.recipientDid, t.createdAt.desc()),
]);

// ---- rebuildable cache (phase 2) ----
export const engagement = pgTable("engagement", {
  postUri: text("post_uri").primaryKey(),
  likeCount: integer("like_count").notNull().default(0),
  replyCount: integer("reply_count").notNull().default(0),
  repostCount: integer("repost_count").notNull().default(0), // stored; display deferred (spec §3)
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});
```
Add `uniqueIndex, serial` to the drizzle-orm/pg-core import. From `packages/db/`: `pnpm exec drizzle-kit generate --name social_layer`.

- [ ] **Step 2: Failing tests** — `packages/db/src/social.test.ts`. Cover, using `createTestDb()`:

```ts
import { describe, it, expect } from "vitest";
import { createTestDb } from "./test-db.js";
import { engagement, interactions } from "./schema.js";
import { engagementFor, recordInteraction, softDeleteInteraction, findInteraction, interactionWritesInWindow, pushNotification, unreadCount, notificationsPage, markAllRead } from "./social.js";

const POST = "at://did:plc:a/app.bsky.feed.post/p1";
const like = (n: number) => ({ recordUri: `at://did:plc:v/app.bsky.feed.like/l${n}`, actorDid: "did:plc:v", kind: "like" as const, subjectUri: POST });

describe("count formula (spec §3 races)", () => {
  it("adds local likes newer than fetchedAt", async () => {
    const db = await createTestDb();
    await db.insert(engagement).values({ postUri: POST, likeCount: 5, fetchedAt: new Date(Date.now() - 60_000) });
    await recordInteraction(db, like(1)); // created now > fetchedAt
    expect((await engagementFor(db, [POST])).get(POST)).toEqual({ likeCount: 6, replyCount: 0 });
  });
  it("does NOT double-count a like the sweep already absorbed", async () => {
    const db = await createTestDb();
    await recordInteraction(db, like(1));
    await db.insert(engagement).values({ postUri: POST, likeCount: 6, fetchedAt: new Date(Date.now() + 1000) }); // sweep after the like
    expect((await engagementFor(db, [POST])).get(POST)!.likeCount).toBe(6);
  });
  it("subtracts an unlike of an absorbed like", async () => {
    const db = await createTestDb();
    await recordInteraction(db, like(1));
    await db.insert(engagement).values({ postUri: POST, likeCount: 6, fetchedAt: new Date(Date.now() + 1000) });
    await softDeleteInteraction(db, like(1).recordUri); // deletedAt now > fetchedAt
    expect((await engagementFor(db, [POST])).get(POST)!.likeCount).toBe(5);
  });
  it("like+unlike both pending nets to zero delta", async () => {
    const db = await createTestDb();
    await db.insert(engagement).values({ postUri: POST, likeCount: 5, fetchedAt: new Date(Date.now() - 60_000) });
    await recordInteraction(db, like(1));
    await softDeleteInteraction(db, like(1).recordUri);
    expect((await engagementFor(db, [POST])).get(POST)!.likeCount).toBe(5);
  });
  it("returns zeros for posts with no engagement row", async () => {
    const db = await createTestDb();
    expect((await engagementFor(db, [POST])).get(POST)).toEqual({ likeCount: 0, replyCount: 0 });
  });
});

describe("interactions helpers", () => {
  it("findInteraction excludes soft-deleted; window count includes them", async () => {
    const db = await createTestDb();
    await recordInteraction(db, like(1));
    await softDeleteInteraction(db, like(1).recordUri);
    expect(await findInteraction(db, "did:plc:v", "like", POST)).toBeNull();
    expect(await interactionWritesInWindow(db, "did:plc:v", 300_000)).toBe(1);
  });
});

describe("notifications", () => {
  const notif = { recipientDid: "did:plc:a", actorDid: "did:plc:v", actorHandle: "v.test", kind: "like" as const, subjectUri: POST, linkUri: POST };
  it("dedupes on (kind, subject, actor, recipient)", async () => {
    const db = await createTestDb();
    await pushNotification(db, notif);
    await pushNotification(db, notif);
    expect(await unreadCount(db, "did:plc:a")).toBe(1);
  });
  it("markAllRead clears unread; page returns newest first", async () => {
    const db = await createTestDb();
    await pushNotification(db, notif);
    await pushNotification(db, { ...notif, kind: "comment" as const, subjectUri: POST + "#r1", snippet: "nice" });
    const page = await notificationsPage(db, "did:plc:a", { limit: 10 });
    expect(page.items).toHaveLength(2);
    await markAllRead(db, "did:plc:a");
    expect(await unreadCount(db, "did:plc:a")).toBe(0);
  });
});
```
Run: `pnpm --filter @openphotos/db test` — FAIL (social.js missing).

- [ ] **Step 3: Implement** `packages/db/src/social.ts`:

```ts
import { and, eq, gt, inArray, isNull, sql, desc, lt } from "drizzle-orm";
import { interactions, engagement, notifications } from "./schema.js";
import type { Db } from "./client.js";

type NewInteraction = { recordUri: string; actorDid: string; kind: "like" | "comment" | "follow"; subjectUri: string; text?: string | null; recordCid?: string | null };

export async function recordInteraction(db: Db, row: NewInteraction) {
  await db.insert(interactions).values(row).onConflictDoNothing();
}
export async function softDeleteInteraction(db: Db, recordUri: string) {
  await db.update(interactions).set({ deletedAt: new Date() }).where(eq(interactions.recordUri, recordUri));
}
export async function findInteraction(db: Db, actorDid: string, kind: "like" | "comment" | "follow", subjectUri: string) {
  const [row] = await db.select().from(interactions)
    .where(and(eq(interactions.actorDid, actorDid), eq(interactions.kind, kind), eq(interactions.subjectUri, subjectUri), isNull(interactions.deletedAt)));
  return row ?? null;
}
export async function interactionWritesInWindow(db: Db, actorDid: string, windowMs: number) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(interactions)
    .where(and(eq(interactions.actorDid, actorDid), gt(interactions.createdAt, new Date(Date.now() - windowMs))));
  return r?.n ?? 0;
}

export async function engagementFor(db: Db, postUris: string[]): Promise<Map<string, { likeCount: number; replyCount: number }>> {
  const out = new Map(postUris.map((u) => [u, { likeCount: 0, replyCount: 0 }]));
  if (!postUris.length) return out;
  const base = await db.select().from(engagement).where(inArray(engagement.postUri, postUris));
  const fetchedAt = new Map(base.map((b) => [b.postUri, b.fetchedAt]));
  for (const b of base) out.set(b.postUri, { likeCount: b.likeCount, replyCount: b.replyCount });
  // one grouped delta query (spec §3): creates/deletes newer than the row's fetchedAt
  const deltas = await db.select({
    subjectUri: interactions.subjectUri, kind: interactions.kind,
    createdAt: interactions.createdAt, deletedAt: interactions.deletedAt,
  }).from(interactions).where(and(inArray(interactions.subjectUri, postUris), inArray(interactions.kind, ["like", "comment"])));
  for (const d of deltas) {
    const cur = out.get(d.subjectUri)!;
    const fa = fetchedAt.get(d.subjectUri) ?? new Date(0);
    const field = d.kind === "like" ? "likeCount" : "replyCount";
    if (d.createdAt > fa && !d.deletedAt) cur[field] += 1;             // pending create
    else if (d.createdAt > fa && d.deletedAt) { /* net zero */ }
    else if (d.deletedAt && d.deletedAt > fa) cur[field] -= 1;         // pending delete of absorbed create
  }
  return out;
}

type NewNotification = { recipientDid: string; actorDid: string; actorHandle: string; actorAvatarUrl?: string | null; kind: "like" | "comment" | "follow"; subjectUri: string; linkUri: string; snippet?: string | null };
export async function pushNotification(db: Db, row: NewNotification) {
  await db.insert(notifications).values(row).onConflictDoNothing();
}
export async function unreadCount(db: Db, recipientDid: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications)
    .where(and(eq(notifications.recipientDid, recipientDid), isNull(notifications.readAt)));
  return r?.n ?? 0;
}
export async function notificationsPage(db: Db, recipientDid: string, opts: { limit: number; cursor?: number }) {
  const rows = await db.select().from(notifications)
    .where(and(eq(notifications.recipientDid, recipientDid), opts.cursor ? lt(notifications.id, opts.cursor) : sql`true`))
    .orderBy(desc(notifications.id)).limit(opts.limit + 1);
  const items = rows.slice(0, opts.limit);
  return { items, cursor: rows.length > opts.limit ? items[items.length - 1].id : null };
}
export async function markRead(db: Db, recipientDid: string, ids: number[]) {
  if (!ids.length) return;
  await db.update(notifications).set({ readAt: new Date() })
    .where(and(eq(notifications.recipientDid, recipientDid), inArray(notifications.id, ids), isNull(notifications.readAt)));
}
export async function markAllRead(db: Db, recipientDid: string) {
  await db.update(notifications).set({ readAt: new Date() })
    .where(and(eq(notifications.recipientDid, recipientDid), isNull(notifications.readAt)));
}
```
Note the delta walk is per-row in JS over a single query's results — acceptable and clear; keep it (the "one grouped query" constraint is about avoiding per-tile queries, satisfied).

- [ ] **Step 4: GREEN + typecheck + commit** — `pnpm --filter @openphotos/db test`, root `pnpm typecheck && pnpm build`. Commit: `feat(db): social tables + count-formula and notification helpers`.

---

### Task 2: Interaction record builders (`packages/atproto`)

**Files:**
- Create: `packages/atproto/src/interaction-records.ts`, `packages/atproto/src/interaction-records.test.ts`
- Modify: `packages/atproto/src/index.ts` (export)

**Interfaces:**
- Produces: `buildLikeRecord(subject: { uri: string; cid: string }, now?: Date)` → `{ $type: "app.bsky.feed.like", subject, createdAt }`; `buildReplyRecord(text: string, root: { uri: string; cid: string }, parent: { uri: string; cid: string }, now?: Date)` → `{ $type: "app.bsky.feed.post", text, reply: { root, parent }, createdAt }`; `buildFollowRecord(subjectDid: string, now?: Date)` → `{ $type: "app.bsky.graph.follow", subject: subjectDid, createdAt }`; `graphemeLength(s: string): number` (via `Intl.Segmenter`); `COMMENT_MAX_GRAPHEMES = 300`.

- [ ] **Step 1: Failing tests** — assert exact record shapes; reply root≠parent for nested comments; `graphemeLength("👩‍👩‍👧‍👦❤️") === 2`; builders throw on empty text / text over 300 graphemes (`buildReplyRecord`).

```ts
import { describe, it, expect } from "vitest";
import { buildLikeRecord, buildReplyRecord, buildFollowRecord, graphemeLength, COMMENT_MAX_GRAPHEMES } from "./interaction-records.js";

const post = { uri: "at://did:plc:a/app.bsky.feed.post/p1", cid: "bafyp1" };
const reply = { uri: "at://did:plc:b/app.bsky.feed.post/r1", cid: "bafyr1" };
const now = new Date("2026-07-23T00:00:00Z");

describe("builders", () => {
  it("like", () => expect(buildLikeRecord(post, now)).toEqual({ $type: "app.bsky.feed.like", subject: post, createdAt: now.toISOString() }));
  it("top-level comment: root === parent === post", () => {
    const r = buildReplyRecord("nice", post, post, now);
    expect(r).toEqual({ $type: "app.bsky.feed.post", text: "nice", reply: { root: post, parent: post }, createdAt: now.toISOString() });
  });
  it("nested comment: root is the post, parent is the comment", () => {
    expect(buildReplyRecord("agreed", post, reply, now).reply).toEqual({ root: post, parent: reply });
  });
  it("follow", () => expect(buildFollowRecord("did:plc:a", now)).toEqual({ $type: "app.bsky.graph.follow", subject: "did:plc:a", createdAt: now.toISOString() }));
  it("rejects empty and over-limit text", () => {
    expect(() => buildReplyRecord("", post, post, now)).toThrow();
    expect(() => buildReplyRecord("x".repeat(COMMENT_MAX_GRAPHEMES + 1), post, post, now)).toThrow();
  });
  it("graphemes not code units", () => expect(graphemeLength("👩‍👩‍👧‍👦❤️")).toBe(2));
});
```

- [ ] **Step 2: RED, implement, GREEN.**

```ts
export const COMMENT_MAX_GRAPHEMES = 300; // app.bsky.feed.post text cap (spec §4)
const seg = new Intl.Segmenter();
export function graphemeLength(s: string): number { let n = 0; for (const _ of seg.segment(s)) n++; return n; }

type Ref = { uri: string; cid: string };
export function buildLikeRecord(subject: Ref, now = new Date()) {
  return { $type: "app.bsky.feed.like" as const, subject, createdAt: now.toISOString() };
}
export function buildReplyRecord(text: string, root: Ref, parent: Ref, now = new Date()) {
  const len = graphemeLength(text.trim());
  if (len < 1 || len > COMMENT_MAX_GRAPHEMES) throw new Error(`comment must be 1–${COMMENT_MAX_GRAPHEMES} graphemes`);
  return { $type: "app.bsky.feed.post" as const, text, reply: { root, parent }, createdAt: now.toISOString() };
}
export function buildFollowRecord(subjectDid: string, now = new Date()) {
  return { $type: "app.bsky.graph.follow" as const, subject: subjectDid, createdAt: now.toISOString() };
}
```
Export from barrel. Commit: `feat(atproto): interaction record builders`.

---

### Task 3: AppView client (`packages/atproto`)

**Files:**
- Create: `packages/atproto/src/appview.ts`, `packages/atproto/src/appview.test.ts`, fixtures under `packages/atproto/src/fixtures/appview/` (captured REAL responses)
- Modify: `packages/atproto/src/index.ts`

**Interfaces:**
- Produces: `class AppView { constructor(base = "https://public.api.bsky.app", fetchJson = safeJsonFetch) }` with `getPosts(uris: string[]): Promise<PostView[]>` (auto-chunks 25), `getPostThread(uri: string, depth = 10): Promise<ThreadView>`, `getLikes(uri: string, limit = 100): Promise<LikeView[]>`, `getFollowers(did: string, limit = 100): Promise<ActorView[]>`, `getProfile(did: string): Promise<ProfileView>`. Types are STRUCTURAL (declare only the fields we read: `uri, cid, likeCount, replyCount, repostCount, author{did,handle,avatar}, record.text, replies[], indexedAt, createdAt, actor{...}`) — not the full lexicon types.

- [ ] **Step 1: Capture fixtures.** `curl` the real API for Kevin's known post (`at://did:plc:ka5oytd2d6rhs2r6yrvt6yb2/app.bsky.feed.post/3mrap7bkyuc2t`): `getPosts`, `getPostThread`, `getLikes` (may be empty — that's a valid fixture), and `getFollowers` for his DID. Save raw JSON per file.
- [ ] **Step 2: Failing tests** with an injected `fetchJson` that asserts the exact URL (path + query incl. chunking: 30 URIs → two getPosts calls of 25 + 5) and returns fixtures; assert parsed fields (counts, author handles, reply nesting).
- [ ] **Step 3: Implement** — thin URL-building + JSON extraction; no retries here (callers own policy); `getPosts` chunks sequentially and concatenates. Commit: `feat(atproto): bsky appview client with real-response fixtures`.

---

### Task 4: Viewer sign-in + header account menu (`apps/web`)

**Files:**
- Create: `apps/web/app/login/page.tsx`, `apps/web/lib/oauth-state.ts`, `apps/web/lib/oauth-state.test.ts`
- Modify: `apps/web/lib/oauth.ts` (authorize accepts app-state), `apps/web/app/oauth/callback/route.ts` (fork on mode), `apps/web/app/register/actions.ts` (`startLogin` gains mode+returnTo), `apps/web/app/layout.tsx` (header: Sign in / account menu / bell placeholder)

**Interfaces:**
- Consumes: `getOAuthClient(db)`, `getSession()` (existing `apps/web/lib/session.ts` — iron-session `{did?, handle?}` + isAdmin).
- Produces: `encodeAppState({ mode: "viewer" | "register", returnTo?: string }): string` / `decodeAppState(s): AppState` (returnTo validated: must start with single `/`, no `//`, no scheme); callback forks: `register` → existing `/register/sources` flow; `viewer` → session set, redirect `returnTo ?? "/"`. Header shows: signed-out → "Sign in" link to `/login`; viewer session → handle + Sign out; photographer session (photographers row exists) → handle menu + Settings (+ bell added in Task 9).

- [ ] **Step 1: VERIFY-API step (mandatory):** read `node_modules/@atproto/oauth-client-node` README/types for the `state` parameter on `authorize()` and its round-trip in `callback()`. If custom state is unsupported, fall back to a `oauth_app_state` short-TTL DB row keyed by the request `state` id — decide from the installed API and document in the report.
- [ ] **Step 2: TDD `oauth-state.ts`** — encode/decode round-trip; returnTo validation (`/photo/x` ok; `//evil.com`, `https://evil.com`, `javascript:` → null).
- [ ] **Step 3: Wire pages/actions.** `/login`: handle-or-server input like `/register` but calls `startLogin(handle, { mode: "viewer", returnTo })` (returnTo from `?returnTo=` query, validated). Callback fork per Produces. Header per Produces (server component; photographer check = one `photographers` lookup by session did).
- [ ] **Step 4: Tests + zero-env build + commit** `feat(web): viewer sign-in with mode/returnTo state fork`.

---

### Task 5: Interaction service — router, rate limit, like/unlike (`apps/web`)

**Files:**
- Create: `apps/web/lib/interactions.ts`, `apps/web/lib/interactions.test.ts`, `apps/web/app/photo/actions.ts`
- Modify: nothing else yet (UI in Task 7)

**Interfaces:**
- Consumes: Task 1 helpers, Task 2 builders, `getSession()`, `getOAuthClient(db)` (restore → `Agent` from `@atproto/api`), `getPhotoRecord`.
- Produces: `routeInteraction(photo: { source: string; atUri: string; recordCid: string }): { supported: true; subject: { uri: string; cid: string } } | { supported: false }`; `likePhoto(db, agentFactory, actorDid, subject): Promise<{ ok: true } | { ok: false; error: string }>`; `unlikePhoto(...)`; `RATE_LIMIT = { max: 30, windowMs: 300_000 }`; `assertRateLimit(db, actorDid)` (throws `RateLimitError`); `agentFactory: (did: string) => Promise<Agent>` — production impl `restoreAgent(db, did)` via `client.restore(did)` + `new Agent(session)`; tests inject a fake. Server actions in `photo/actions.ts`: `likeAction(formData)`, `unlikeAction(formData)` — session-checked, then service.

- [ ] **Step 1: Failing tests** (createTestDb + fake agent recording calls):
  - router: bsky photo → subject uri+cid; luminance/grain → `{supported:false}`.
  - like: agent `com.atproto.repo.createRecord` called with `buildLikeRecord` shape; `interactions` row keyed by returned record uri; notification row pushed when subject photographer registered & ≠ actor; NOT pushed when actor === photographer.
  - like when photographer NOT registered → no notification row, interaction still recorded.
  - rate limit: 30 rows in window → 31st throws `RateLimitError`; soft-deleted rows count.
  - unlike: soft-deletes + agent `deleteRecord` with the stored rkey; missing row + fake agent listRecords returning the like on page 2 → found; fake returning 11 pages of misses → graceful `{ok:false}` (cap 10).
  - DB-half failure self-heal: agent create succeeds, `recordInteraction` throws (inject failing db wrapper) → action returns ok:false BUT no crash (record-first ordering is the contract; sweep heals).
- [ ] **Step 2: Implement.** Record-first ordering; notification `linkUri` = photo atUri; snippet null for likes. Unlike deletes via `deleteRecord({ repo: actorDid, collection: "app.bsky.feed.like", rkey })` parsed from stored recordUri.
- [ ] **Step 3: GREEN + commit** `feat(web): interaction service — router, rate limit, like/unlike write-through`.

---

### Task 6: Comment + follow + delete-own-comment actions

**Files:**
- Modify: `apps/web/lib/interactions.ts` (+tests), `apps/web/app/photo/actions.ts`, create `apps/web/app/[handle]/actions.ts` (follow/unfollow)

**Interfaces:**
- Consumes: Task 5 service patterns, `buildReplyRecord`, `buildFollowRecord`.
- Produces: `commentOnPhoto(db, agentFactory, actorDid, actorHandle, { subject, parent?, text })` (parent defaults to subject; notification snippet = first 140 chars); `deleteOwnComment(db, agentFactory, actorDid, recordUri)` (ownership check: recordUri's repo DID === actorDid, else error); `followPhotographer(db, agentFactory, actorDid, photographerDid)` / `unfollowPhotographer(...)` (notification linkUri = `/` + photographer handle at push time); server actions `commentAction`, `deleteCommentAction`, `followAction`, `unfollowAction`.

- [ ] **Step 1: Failing tests** — comment record shape (root=subject, parent=comment for nested); 300-grapheme rejection surfaces as `{ok:false}` not a throw; delete-own rejects foreign recordUri; follow notification dedupe (second follow after unfollow+refollow does NOT duplicate — unique key covers it); follow when photographer unregistered → no notification.
- [ ] **Step 2: Implement + GREEN + commit** `feat(web): comment, follow, delete-own-comment actions`.

---

### Task 7: Photo page surfaces — like button, thread, composer

**Files:**
- Create: `apps/web/components/like-button.tsx` (client), `apps/web/components/comment-thread.tsx` (server), `apps/web/components/comment-composer.tsx` (client), `apps/web/lib/thread.ts`, `apps/web/lib/thread.test.ts`
- Modify: `apps/web/app/photo/[did]/[collection]/[rkey]/page.tsx`

**Interfaces:**
- Consumes: `AppView.getPostThread` (60s cache via `unstable_cache` or fetch-cache equivalent already used in repo — match existing pattern), `engagementFor`, `findInteraction`, actions from Tasks 5–6, `isSensitive` + `SensitiveImage` blur-gate, `safeExternalHref` patterns.
- Produces: `flattenThread(thread, { maxDepth: 2 }): CommentNode[]` where `CommentNode = { uri, cid, authorDid, authorHandle, authorAvatarUrl, text, createdAt, depth, labels: string[], hasMore: boolean }` — skips blocked/notFound stubs (render as absent, spec §7), carries labels for blur-gating.
- Photo page renders: like button (filled = `findInteraction` hit; count from `engagementFor`), thread (labeled nodes behind blur-gate; avatars from bsky CDN URLs — explicit exception), composer (session ? composer with 300-grapheme live counter : "Sign in to comment" linking `/login?returnTo=<this page>`), delete button on own comments, "Continue this thread on Bluesky" link when `hasMore`/depth-clipped. Non-bsky-source photos: disabled interaction row, copy exactly: "Interactions arrive with portfolio publishing".

- [ ] **Step 1: TDD `flattenThread`** against Task 3's real thread fixture + hand-built fixtures for: blocked stub (absent), labeled reply (labels carried), depth-3 nesting (clipped at 2 with hasMore).
- [ ] **Step 2: Components + page wiring** (server components fetch; client components only for stateful button/composer — match photo-card.tsx patterns; optimistic UI via `useTransition` + router.refresh, no client cache).
- [ ] **Step 3: Zero-env build + web tests green + commit** `feat(web): photo page social surfaces`.

---

### Task 8: Feed tile counts + profile follow

**Files:**
- Modify: `apps/web/app/page.tsx`, `apps/web/components/photo-grid.tsx`, `apps/web/components/photo-card.tsx` (counts overlay props), `apps/web/app/[handle]/page.tsx` (Follow button + follower count)
- Create: `apps/web/components/follow-button.tsx` (client)

**Interfaces:**
- Consumes: `engagementFor` (ONE call per page render with all post URIs — global constraint), Task 6 follow actions, `AppView.getProfile` (follower count, 300s revalidate; viewer follow-state via authed `agent.getProfile` only when session exists).
- Produces: `PhotoCard` gains optional `likeCount?: number; replyCount?: number` (renders small overlay when provided; same number on every tile of a multi-image post — by design, spec §3).

- [ ] **Step 1: Wire feed + profile pages; counts join in one grouped call.** Follow button states: follow/unfollow/signed-out (links `/login?returnTo=`).
- [ ] **Step 2: Build green, existing tests green, commit** `feat(web): tile counts + profile follow`.

---

### Task 9: Engagement sweep (ingestor)

**Files:**
- Create: `apps/ingestor/src/engagement-sweep.ts`, `apps/ingestor/src/engagement-sweep.test.ts`
- Modify: `apps/ingestor/src/main.ts` (start sweep in `startBackgroundJobs`)

**Interfaces:**
- Consumes: `AppView` (injected, tests use a local HTTP fixture server or injected fetchJson), db tables/helpers, `photographers`/`photos`.
- Produces: `runEngagementSweep(db, appview, opts?: { likesPageSize?: number; sweepIndex?: number }): Promise<void>`; `startEngagementSweep(db, opts): { stop(): void }` — base interval 3 min; computes governed interval `max(180_000, Math.ceil((requestsPerSweep / 240) * 60_000))` and logs it (240 = 40% of the ~600 req/min public budget; at ~200 requests/sweep the 3-min base holds); follower diff only when `sweepIndex % 5 === 0`; prunes `interactions` where `deletedAt < engagement.fetchedAt` for their subject; staleness check: oldest fetchedAt > 30 min → `console.error("engagement_staleness_seconds=…")` + Sentry-if-enabled (mirror cursor-lag pattern in main.ts).

- [ ] **Step 1: Failing tests** (createTestDb + injected appview stub):
  - counts upserted from getPosts for registered-active photographers' bsky post URIs only (deregistered/luminance-source excluded).
  - like_count rise → getLikes called → notification rows with actorHandle/avatarUrl/linkUri=photo uri; second sweep with same data → no duplicates.
  - reply rise → thread walk → one notification per new reply URI; reply by the photographer themself → no self-notification.
  - follower diff runs only on sweepIndex divisible by 5; new follower → notification kind=follow linkUri=`/`+handle.
  - 429 from appview stub → tick aborts, no partial corruption (rows before abort kept — assert independence), next run resumes.
  - prune: soft-deleted interaction older than fetchedAt removed; newer kept.
- [ ] **Step 2: Implement + GREEN.** Wire into `startBackgroundJobs` beside the backfill loop (keep timer handle). Commit: `feat(ingestor): engagement sweep with notification diffing + governor`.

---

### Task 10: Notification center (`apps/web`)

**Files:**
- Create: `apps/web/app/notifications/page.tsx`, `apps/web/app/notifications/actions.ts`, `apps/web/components/mark-read-on-mount.tsx` (client), `apps/web/components/bell.tsx`
- Modify: `apps/web/app/layout.tsx` (bell for photographer sessions)

**Interfaces:**
- Consumes: `unreadCount`, `notificationsPage`, `markRead`, `markAllRead`, session.
- Produces: `/notifications` (photographer-session-gated; viewers/anon → redirect `/login?returnTo=/notifications`): 50/page keyset by id, rows per spec §6 (avatar img from `actorAvatarUrl` bsky CDN, verb per kind — "liked your photo" / "commented: <snippet>" / "followed you", relative time, link to `linkUri` route: photo `linkUri` → `/photo/...` path via `splitAtUri`, follow linkUri already a path). `MarkReadOnMount` posts `markReadAction(ids)` in `useEffect` AFTER MOUNT (never during render — spec §6 prefetch hazard; include this exact rationale as a comment). Bell (header, photographer sessions): unread badge, links `/notifications`.

- [ ] **Step 1: Action tests** (markReadAction session-scoping: cannot mark another recipient's rows — recipientDid always from session).
- [ ] **Step 2: Pages/components + build green + commit** `feat(web): notification center with mount-gated read marking`.

---

### Task 11: Integration + E2E starter + docs

**Files:**
- Create: `apps/web/src`—no; Create: `apps/ingestor/src/integration/social.dev-env.test.ts` (runs under existing `test:integration` config), `apps/web/e2e/photo-social.spec.ts` + `apps/web/playwright.config.ts`
- Modify: `docs/TODO.md` (check off phase-2 spec item; log conscious cuts), `docs/runbooks/launch-alpha.md` (append §: verifying social layer — success criteria 1–3 from spec §11 as a manual checklist)

**Interfaces:**
- Consumes: everything; `@atproto/dev-env` patterns from `dev-env.test.ts` (SQLite-native, password sessions).

- [ ] **Step 1: dev-env integration test:** create photographer + viewer accounts on the local PDS; photographer posts an image post (reuse the tiny-JPEG helper); index it via `runBackfill` (existing injection seams); viewer likes + comments through `likePhoto`/`commentOnPhoto` with a password-session `Agent` as the agentFactory; assert the records exist in the viewer's repo (`listRecords`) AND write-through rows exist; unlike + delete-comment round-trips; `engagementFor` reflects pending deltas.
- [ ] **Step 2: Playwright starter** (runs against `next dev` with a seeded PGlite? No — run against dev server + real DATABASE_URL from `.env.local`; document as local/pre-release, NOT CI — spec §9): photo page renders thread region; signed-out composer shows "Sign in to comment" linking `/login`.
- [ ] **Step 3: Docs + commit** `test(social): dev-env integration + e2e starter; docs`.

---

## Self-Review (completed)

1. **Spec coverage:** §1 decisions → constraints block; §2 architecture → T2/3 (atproto), T1 (db), T4–8/10 (web), T9 (ingestor); §3 data model + count formula + link_uri + dedupe → T1 (tests enumerate every race the spec names); §4 write path (sign-in fork/state ⚠ → T4 verify-API step; rate limit/like/unlike cap/comment 300/follow → T5/6); §5 sweep (governor, 5th-sweep follows, 429, staleness, prune, avatar exception) → T9 (+T7/T10 render the CDN avatars); §6 notifications (mount-gated mark-read, mark-all, bell gating) → T10; §7 surfaces (blur-gated threads, blocked-stub absence, disabled non-bsky row, honest like-button seam, 2-level clip) → T7/8; §8 error handling → distributed into T5 (self-heal ordering, graceful ok:false), T7 (degraded thread copy), T9 (tick abort); §9 testing → each task TDD + T11; §10 cuts respected (no repost UI, no viewer notifications, no grain writes); §11 criteria → T11 runbook checklist. No gaps found.
2. **Placeholder scan:** T3/T4/T7/T8/T10 steps carry prose-specified UI/wiring with exact interfaces and copy strings rather than full JSX listings — deliberate for page code in an established codebase with strong existing patterns (photo-card, register pages); all logic-bearing code (formula, service, builders, sweep) is written out. No TBD/TODO markers exist.
3. **Type consistency:** `engagementFor` Map shape used in T1/T7/T8 matches; `agentFactory(did) → Agent` consistent T5/6/11; `CommentNode` produced T7 consumed only T7; notification field names (`actorAvatarUrl`, `linkUri`) consistent T1/T5/T9/T10; `RateLimitError` thrown T5, surfaced as `{ok:false}` at the action boundary (stated in T6 test).
