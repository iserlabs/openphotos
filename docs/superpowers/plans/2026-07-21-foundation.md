# Luminance Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Foundation of luminance.social — the `social.luminance.*` lexicon, an ATProto AppView (Jetstream ingestion + backfill into Postgres), an image proxy, and the Next.js hub with OAuth registration — per `docs/superpowers/specs/2026-07-21-luminance-foundation-design.md`.

**Architecture:** Turbo/pnpm monorepo. `apps/web` (Next.js 16, Vercel) serves the hub, OAuth registration, and the allowlisted image proxy. `apps/ingestor` (Node container, Fly.io) runs a Jetstream connection manager and backfill jobs, writing through shared record mappers into Neon Postgres via Drizzle. Index tables are rebuildable; app-state tables (`photographers`, `photo_overrides`, OAuth stores) are durable.

**Tech Stack:** TypeScript, pnpm + Turbo, Next.js 16 (App Router) + React 19 + Tailwind 4, Drizzle ORM + Neon Postgres (PGlite in tests), `@atproto/api`, `@atproto/oauth-client-node`, `@atproto/lex-cli`, `@atproto/dev-env` (integration tests), `ws`, `sharp`, `iron-session`, Vitest, Playwright, Sentry.

## Global Constraints

- All app routes are **dotless** path segments (handles always contain a dot; `/[handle]` must never collide). Spec §10.
- `photos` and `photo_overrides` use composite PK `(at_uri, media_index)`; record deletion removes **all** rows for the AT-URI. Spec §8.
- `sort_at` = coalesce(capturedAt, createdAt) clamped to `indexed_at` + **10 minutes** max. Spec §8.
- Backfill caps at the **5,000** most recent records per collection per DID. Spec §9.
- Lexicon photo blob `maxSize` = **20MB** (20971520). Spec §7. No GPS fields may exist anywhere in the lexicon.
- Image proxy serves **only** blobs referenced by the index (photo `blob_cid` or photographer `avatar_cid`); 404 before any upstream fetch otherwise. Spec §11.
- All server-side fetches to PDS endpoints: **HTTPS-only, public-IP-only** (SSRF guard). Spec §11.
- Proxy responses for existing blobs: `Cache-Control: public, max-age=31536000, immutable`. Blob-fetch failures: 502 with `Cache-Control: public, max-age=30` (negative cache). Spec §10/§12.
- Ingest cursor advances only **after** a batch commits. Invalid records are skipped + counted, never crash the stream. Spec §9/§12.
- Index only: `social.luminance.*`; top-level `app.bsky.feed.post` with `app.bsky.embed.images` (skip replies, skip quote-posts-with-media); `social.grain.*`; `app.bsky.actor.profile` (fallback profile). We never write anyone else's lexicon. Spec §7.
- Environment variables (exact names): `DATABASE_URL`, `PUBLIC_URL`, `JETSTREAM_URL`, `SESSION_SECRET`, `OAUTH_JWK_1`, `ADMIN_DIDS` (comma-sep DIDs), `SENTRY_DSN` (optional).
- Registration default is auto-approve (`status='active'`); `pending_review` exists in the enum from day one. Spec §10.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.nvmrc`
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/src/index.ts`, `packages/db/src/smoke.test.ts`

**Interfaces:**
- Produces: workspace layout `apps/*`, `packages/*`; root scripts `pnpm test`, `pnpm typecheck`, `pnpm build`. `tsconfig.base.json` with `"strict": true`, `"module": "NodeNext"`.

- [ ] **Step 1: Write workspace config**

`package.json`:
```json
{
  "name": "luminance-social",
  "private": true,
  "packageManager": "pnpm@10.12.1",
  "scripts": {
    "build": "turbo build",
    "test": "turbo test",
    "typecheck": "turbo typecheck"
  },
  "devDependencies": { "turbo": "^2.5.0", "typescript": "^5.8.0", "vitest": "^3.2.0" }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "strict": true, "module": "NodeNext", "moduleResolution": "NodeNext",
    "target": "ES2022", "lib": ["ES2022"], "skipLibCheck": true,
    "declaration": true, "sourceMap": true, "esModuleInterop": true
  }
}
```

`.gitignore`: `node_modules`, `dist`, `.next`, `.turbo`, `.env*`, `!.env.example`, `coverage`. `.nvmrc`: `24`.

`packages/db/package.json`:
```json
{
  "name": "@luminance/db",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run", "typecheck": "tsc --noEmit" }
}
```

`packages/db/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

`packages/db/src/index.ts`:
```ts
export const DB_PACKAGE = "@luminance/db";
```

- [ ] **Step 2: Write smoke test** — `packages/db/src/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { DB_PACKAGE } from "./index.js";
describe("workspace", () => { it("resolves", () => expect(DB_PACKAGE).toBe("@luminance/db")); });
```

- [ ] **Step 3: Install and run** — Run: `pnpm install && pnpm test`
Expected: turbo runs `@luminance/db` test, 1 passed.

- [ ] **Step 4: Commit**
```bash
git add -A && git commit -m "chore: scaffold pnpm+turbo monorepo"
```

---

### Task 2: Database schema and query helpers (`packages/db`)

**Files:**
- Create: `packages/db/src/schema.ts`, `packages/db/src/client.ts`, `packages/db/src/feed.ts`, `packages/db/src/test-db.ts`, `packages/db/drizzle.config.ts`
- Create: `packages/db/src/feed.test.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/package.json` (deps)

**Interfaces:**
- Produces: Drizzle tables `photographers`, `photos`, `photoOverrides`, `series`, `seriesPhotos`, `ingestCursors`, `tombstones`, `oauthStates`, `oauthSessions`; `createDb(url): Db`; `feedPage(db, { limit, cursor }): Promise<{ items: FeedRow[]; cursor: string | null }>`; `createTestDb(): Promise<Db>` (PGlite + migrations, for all downstream tests).

- [ ] **Step 1: Add deps**
```bash
pnpm --filter @luminance/db add drizzle-orm postgres && pnpm --filter @luminance/db add -D drizzle-kit @electric-sql/pglite
```

- [ ] **Step 2: Write schema** — `packages/db/src/schema.ts` (complete, per spec §8):
```ts
import { pgTable, pgEnum, text, integer, boolean, timestamp, jsonb, bigint, primaryKey, index } from "drizzle-orm/pg-core";

export const photographerStatus = pgEnum("photographer_status",
  ["active", "pending_review", "deactivated", "deregistered", "takedown"]);
export const backfillStatus = pgEnum("backfill_status", ["pending", "running", "complete", "failed"]);
export const photoSource = pgEnum("photo_source", ["luminance", "bsky", "grain"]);

// ---- durable app state ----
export const photographers = pgTable("photographers", {
  did: text("did").primaryKey(),
  handle: text("handle").notNull(),
  displayName: text("display_name"),
  avatarCid: text("avatar_cid"),
  bio: text("bio"),
  website: text("website"),
  location: text("location"),
  status: photographerStatus("status").notNull().default("active"),
  includeBsky: boolean("include_bsky").notNull().default(true),
  includeGrain: boolean("include_grain").notNull().default(true),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  backfillStatus: backfillStatus("backfill_status").notNull().default("pending"),
});

export const photoOverrides = pgTable("photo_overrides", {
  atUri: text("at_uri").notNull(),
  mediaIndex: integer("media_index").notNull(),
  hidden: boolean("hidden").notNull().default(false),
  takedown: boolean("takedown").notNull().default(false),
  reason: text("reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.atUri, t.mediaIndex] })]);

export const oauthStates = pgTable("oauth_states", {
  key: text("key").primaryKey(), state: jsonb("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const oauthSessions = pgTable("oauth_sessions", {
  key: text("key").primaryKey(), session: jsonb("session").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ingestCursors = pgTable("ingest_cursors", {
  connectionId: text("connection_id").primaryKey(),
  timeUs: bigint("time_us", { mode: "bigint" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// short-lived: delete-during-backfill guard (spec §9)
export const tombstones = pgTable("tombstones", {
  atUri: text("at_uri").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- rebuildable index ----
export const photos = pgTable("photos", {
  atUri: text("at_uri").notNull(),
  mediaIndex: integer("media_index").notNull(),
  did: text("did").notNull(),
  source: photoSource("source").notNull(),
  recordCid: text("record_cid").notNull(),
  blobCid: text("blob_cid").notNull(),
  width: integer("width"), height: integer("height"),
  alt: text("alt"), title: text("title"), caption: text("caption"),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }),
  sortAt: timestamp("sort_at", { withTimezone: true }).notNull(),
  exif: jsonb("exif"),
  tags: text("tags").array().notNull().default([]),
  license: text("license"),
  labels: text("labels").array().notNull().default([]),
  groupKey: text("group_key"),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.atUri, t.mediaIndex] }),
  index("photos_feed_idx").on(t.sortAt.desc(), t.atUri.desc(), t.mediaIndex.desc()),
  index("photos_did_idx").on(t.did, t.sortAt.desc()),
  index("photos_blob_idx").on(t.blobCid),
]);

export const series = pgTable("series", {
  atUri: text("at_uri").primaryKey(),
  did: text("did").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  coverPhotoUri: text("cover_photo_uri"),
  createdAt: timestamp("created_at", { withTimezone: true }),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
});
export const seriesPhotos = pgTable("series_photos", {
  seriesUri: text("series_uri").notNull(),
  photoUri: text("photo_uri").notNull(),
  position: integer("position").notNull(),
}, (t) => [primaryKey({ columns: [t.seriesUri, t.photoUri] })]);
```

- [ ] **Step 3: Client + config** — `packages/db/src/client.ts`:
```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
export type Db = ReturnType<typeof createDb>;
export function createDb(url: string) {
  return drizzle(postgres(url, { prepare: false }), { schema });
}
```
`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/schema.ts", out: "./migrations", dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost/luminance" },
});
```
Run: `pnpm --filter @luminance/db exec drizzle-kit generate --name init`
Expected: `packages/db/migrations/0000_init.sql` created.

`packages/db/src/test-db.ts` (used by every downstream test):
```ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";
const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
export async function createTestDb() {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  return db as unknown as import("./client.js").Db;
}
```

- [ ] **Step 4: Write failing feed test** — `packages/db/src/feed.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./test-db.js";
import { photos, photographers, photoOverrides } from "./schema.js";
import { feedPage } from "./feed.js";
import type { Db } from "./client.js";

const p = (n: number, over: Partial<typeof photos.$inferInsert> = {}): typeof photos.$inferInsert => ({
  atUri: `at://did:plc:a/social.luminance.portfolio.photo/${n}`, mediaIndex: 0,
  did: "did:plc:a", source: "luminance", recordCid: "rc", blobCid: `b${n}`,
  sortAt: new Date(2026, 0, n), ...over,
});

describe("feedPage", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:a", handle: "klee.photos" });
  });
  it("returns newest-first with keyset cursor", async () => {
    await db.insert(photos).values([p(1), p(2), p(3)]);
    const page1 = await feedPage(db, { limit: 2 });
    expect(page1.items.map((i) => i.blobCid)).toEqual(["b3", "b2"]);
    const page2 = await feedPage(db, { limit: 2, cursor: page1.cursor! });
    expect(page2.items.map((i) => i.blobCid)).toEqual(["b1"]);
    expect(page2.cursor).toBeNull();
  });
  it("excludes hidden, takedown, and non-active photographers", async () => {
    await db.insert(photographers).values({ did: "did:plc:b", handle: "x.com", status: "deactivated" });
    await db.insert(photos).values([p(1), p(2), p(3, { atUri: "at://did:plc:b/c/3", did: "did:plc:b" })]);
    await db.insert(photoOverrides).values({ atUri: p(1).atUri, mediaIndex: 0, hidden: true });
    const page = await feedPage(db, { limit: 10 });
    expect(page.items.map((i) => i.blobCid)).toEqual(["b2"]);
  });
});
```
Run: `pnpm --filter @luminance/db test` — Expected: FAIL (`feed.js` not found).

- [ ] **Step 5: Implement** — `packages/db/src/feed.ts`:
```ts
import { and, eq, sql, desc } from "drizzle-orm";
import { photos, photographers, photoOverrides } from "./schema.js";
import type { Db } from "./client.js";

export type FeedRow = typeof photos.$inferSelect & { handle: string; displayName: string | null };

export function encodeCursor(r: { sortAt: Date; atUri: string; mediaIndex: number }): string {
  return Buffer.from(JSON.stringify([r.sortAt.toISOString(), r.atUri, r.mediaIndex])).toString("base64url");
}
export function decodeCursor(c: string): { sortAt: Date; atUri: string; mediaIndex: number } {
  const [s, u, m] = JSON.parse(Buffer.from(c, "base64url").toString());
  return { sortAt: new Date(s), atUri: u, mediaIndex: m };
}

export async function feedPage(db: Db, opts: { limit: number; cursor?: string; did?: string }) {
  const { limit } = opts;
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  const rows = await db
    .select({ photo: photos, handle: photographers.handle, displayName: photographers.displayName })
    .from(photos)
    .innerJoin(photographers, eq(photos.did, photographers.did))
    .leftJoin(photoOverrides, and(eq(photoOverrides.atUri, photos.atUri), eq(photoOverrides.mediaIndex, photos.mediaIndex)))
    .where(and(
      eq(photographers.status, "active"),
      sql`coalesce(${photoOverrides.hidden}, false) = false`,
      sql`coalesce(${photoOverrides.takedown}, false) = false`,
      opts.did ? eq(photos.did, opts.did) : sql`true`,
      cur ? sql`(${photos.sortAt}, ${photos.atUri}, ${photos.mediaIndex}) < (${cur.sortAt}, ${cur.atUri}, ${cur.mediaIndex})` : sql`true`,
    ))
    .orderBy(desc(photos.sortAt), desc(photos.atUri), desc(photos.mediaIndex))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map((r) => ({ ...r.photo, handle: r.handle, displayName: r.displayName }));
  const cursor = rows.length > limit ? encodeCursor(items[items.length - 1]) : null;
  return { items, cursor };
}
```
`packages/db/src/index.ts`:
```ts
export * from "./schema.js";
export * from "./client.js";
export * from "./feed.js";
```
Delete `packages/db/src/smoke.test.ts`.

- [ ] **Step 6: Run** — `pnpm --filter @luminance/db test` — Expected: PASS (2 tests). Also `pnpm typecheck` passes.

- [ ] **Step 7: Commit**
```bash
git add -A && git commit -m "feat(db): schema, migrations, keyset feed query with override filtering"
```

---

### Task 3: Lexicons package (`packages/lexicons`)

**Files:**
- Create: `packages/lexicons/lexicons/social/luminance/portfolio/photo.json`, `.../series.json`, `packages/lexicons/lexicons/social/luminance/actor/profile.json`
- Create: `packages/lexicons/package.json`, `tsconfig.json`, `packages/lexicons/src/index.ts`, `packages/lexicons/src/lexicons.test.ts`

**Interfaces:**
- Produces: NSID constants `LUMINANCE_PHOTO = "social.luminance.portfolio.photo"`, `LUMINANCE_SERIES`, `LUMINANCE_PROFILE`, `BSKY_POST = "app.bsky.feed.post"`, `BSKY_PROFILE = "app.bsky.actor.profile"`, `GRAIN_PREFIX = "social.grain."`; exported `lexicons: LexiconDoc[]` and a `Lexicons` validator instance from `@atproto/lexicon`.

- [ ] **Step 1: Package + deps**
```bash
mkdir -p packages/lexicons/src packages/lexicons/lexicons/social/luminance/{portfolio,actor}
pnpm --filter @luminance/lexicons add @atproto/lexicon
```
`packages/lexicons/package.json` / `tsconfig.json`: same shape as `@luminance/db`'s (name `@luminance/lexicons`).

- [ ] **Step 2: Write lexicon JSON** — `photo.json` (complete; note **no GPS fields exist**, spec §7):
```json
{
  "lexicon": 1,
  "id": "social.luminance.portfolio.photo",
  "defs": {
    "main": {
      "type": "record",
      "description": "A single portfolio photograph.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["image", "createdAt"],
        "properties": {
          "image": { "type": "blob", "accept": ["image/*"], "maxSize": 20971520 },
          "aspectRatio": { "type": "ref", "ref": "#aspectRatio" },
          "alt": { "type": "string", "maxGraphemes": 2000 },
          "title": { "type": "string", "maxGraphemes": 200 },
          "caption": { "type": "string", "maxGraphemes": 3000 },
          "capturedAt": { "type": "string", "format": "datetime" },
          "createdAt": { "type": "string", "format": "datetime" },
          "exif": { "type": "ref", "ref": "#exif" },
          "tags": { "type": "array", "maxLength": 10, "items": { "type": "string", "maxGraphemes": 40 } },
          "license": { "type": "string", "maxGraphemes": 100 },
          "labels": { "type": "union", "refs": ["com.atproto.label.defs#selfLabels"] }
        }
      }
    },
    "aspectRatio": {
      "type": "object", "required": ["width", "height"],
      "properties": { "width": { "type": "integer", "minimum": 1 }, "height": { "type": "integer", "minimum": 1 } }
    },
    "exif": {
      "type": "object",
      "properties": {
        "camera": { "type": "string", "maxGraphemes": 100 },
        "lens": { "type": "string", "maxGraphemes": 100 },
        "focalLength": { "type": "string", "maxGraphemes": 20 },
        "fNumber": { "type": "string", "maxGraphemes": 10 },
        "shutterSpeed": { "type": "string", "maxGraphemes": 20 },
        "iso": { "type": "integer", "minimum": 1 }
      }
    }
  }
}
```
`series.json`:
```json
{
  "lexicon": 1,
  "id": "social.luminance.portfolio.series",
  "defs": {
    "main": {
      "type": "record", "key": "tid",
      "record": {
        "type": "object", "required": ["title", "photos", "createdAt"],
        "properties": {
          "title": { "type": "string", "maxGraphemes": 200 },
          "description": { "type": "string", "maxGraphemes": 3000 },
          "photos": { "type": "array", "maxLength": 500, "items": { "type": "ref", "ref": "com.atproto.repo.strongRef" } },
          "coverPhoto": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```
`profile.json`:
```json
{
  "lexicon": 1,
  "id": "social.luminance.actor.profile",
  "defs": {
    "main": {
      "type": "record", "key": "literal:self",
      "record": {
        "type": "object",
        "properties": {
          "displayName": { "type": "string", "maxGraphemes": 100 },
          "bio": { "type": "string", "maxGraphemes": 1000 },
          "websiteUrl": { "type": "string", "format": "uri" },
          "location": { "type": "string", "maxGraphemes": 100 },
          "avatar": { "type": "blob", "accept": ["image/*"], "maxSize": 2097152 },
          "disciplines": { "type": "array", "maxLength": 10, "items": { "type": "string", "maxGraphemes": 40 } }
        }
      }
    }
  }
}
```

- [ ] **Step 3: Failing test** — `packages/lexicons/src/lexicons.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { lexiconValidator, LUMINANCE_PHOTO } from "./index.js";
describe("luminance lexicons", () => {
  it("validates a well-formed photo record", () => {
    const res = lexiconValidator.validate(LUMINANCE_PHOTO, {
      $type: LUMINANCE_PHOTO,
      image: { $type: "blob", ref: { $link: "bafkreib3vqp" }, mimeType: "image/jpeg", size: 12345 },
      createdAt: "2026-07-21T00:00:00.000Z",
      exif: { camera: "Nikon Z8", iso: 640 },
    });
    expect(res.success).toBe(true);
  });
  it("rejects a photo without an image", () => {
    const res = lexiconValidator.validate(LUMINANCE_PHOTO, { $type: LUMINANCE_PHOTO, createdAt: "2026-07-21T00:00:00.000Z" });
    expect(res.success).toBe(false);
  });
  it("has no GPS-shaped fields anywhere", () => {
    const raw = JSON.stringify(require("../lexicons/social/luminance/portfolio/photo.json"));
    expect(raw.toLowerCase()).not.toMatch(/gps|latitude|longitude/);
  });
});
```
Run: `pnpm --filter @luminance/lexicons test` — Expected: FAIL (no index.ts).

- [ ] **Step 4: Implement** — `packages/lexicons/src/index.ts`:
```ts
import { Lexicons, type LexiconDoc } from "@atproto/lexicon";
import photo from "../lexicons/social/luminance/portfolio/photo.json" with { type: "json" };
import series from "../lexicons/social/luminance/portfolio/series.json" with { type: "json" };
import profile from "../lexicons/social/luminance/actor/profile.json" with { type: "json" };

export const LUMINANCE_PHOTO = "social.luminance.portfolio.photo";
export const LUMINANCE_SERIES = "social.luminance.portfolio.series";
export const LUMINANCE_PROFILE = "social.luminance.actor.profile";
export const BSKY_POST = "app.bsky.feed.post";
export const BSKY_PROFILE = "app.bsky.actor.profile";
export const GRAIN_PREFIX = "social.grain.";

export const lexicons = [photo, series, profile] as LexiconDoc[];
export const lexiconValidator = new Lexicons(lexicons);
```
Note: `com.atproto.label.defs#selfLabels` / `strongRef` refs resolve at *runtime validation of those fields only*; `Lexicons` treats unresolved refs leniently for unknown unions. If `new Lexicons()` throws on unresolved refs, vendor the two upstream docs: download `https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/com/atproto/label/defs.json` and `.../com/atproto/repo/strongRef.json` into `packages/lexicons/lexicons/com/atproto/...` and add them to the `lexicons` array. Do whichever the test run demands — the test is the arbiter.

- [ ] **Step 5: Run** — `pnpm --filter @luminance/lexicons test` — Expected: PASS (3 tests).

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "feat(lexicons): social.luminance.* lexicon docs + validator"
```

---

### Task 4: SSRF guard + identity resolution (`packages/atproto`)

**Files:**
- Create: `packages/atproto/package.json`, `tsconfig.json`, `packages/atproto/src/safe-fetch.ts`, `packages/atproto/src/identity.ts`
- Create: `packages/atproto/src/safe-fetch.test.ts`, `packages/atproto/src/identity.test.ts`

**Interfaces:**
- Produces: `assertPublicHttps(url: string): Promise<URL>` (throws `UnsafeUrlError`); `safeJsonFetch(url: string): Promise<unknown>`; `resolvePdsEndpoint(did: string, fetchJson?): Promise<string>` (accepts injectable fetcher for tests); `isPrivateIp(ip: string): boolean`.

- [ ] **Step 1: Package** — same package.json/tsconfig shape, name `@luminance/atproto`, deps:
```bash
pnpm --filter @luminance/atproto add @luminance/lexicons@workspace:* @luminance/db@workspace:*
```

- [ ] **Step 2: Failing security tests** — `packages/atproto/src/safe-fetch.test.ts` (these are the spec §11/§13 permanent regression fixtures):
```ts
import { describe, it, expect } from "vitest";
import { isPrivateIp, assertPublicHttps, UnsafeUrlError } from "./safe-fetch.js";

describe("SSRF guard", () => {
  it.each(["127.0.0.1", "10.0.0.8", "172.16.5.5", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "fe80::1", "0.0.0.0"])(
    "flags private/reserved ip %s", (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("allows public ip %s", (ip) => expect(isPrivateIp(ip)).toBe(false));
  it("rejects http:// URLs", async () => {
    await expect(assertPublicHttps("http://example.com/x")).rejects.toThrow(UnsafeUrlError);
  });
  it("rejects hosts that resolve to private ranges", async () => {
    await expect(assertPublicHttps("https://localhost/x")).rejects.toThrow(UnsafeUrlError);
  });
});
```
`packages/atproto/src/identity.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolvePdsEndpoint } from "./identity.js";

const didDoc = {
  id: "did:plc:abc",
  service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.com" }],
};
describe("resolvePdsEndpoint", () => {
  it("resolves did:plc via plc.directory", async () => {
    const fetchJson = async (url: string) => { expect(url).toBe("https://plc.directory/did:plc:abc"); return didDoc; };
    expect(await resolvePdsEndpoint("did:plc:abc", fetchJson)).toBe("https://pds.example.com");
  });
  it("rejects a PDS endpoint that is not https", async () => {
    const bad = { ...didDoc, service: [{ ...didDoc.service[0], serviceEndpoint: "http://internal:2583" }] };
    await expect(resolvePdsEndpoint("did:plc:abc", async () => bad)).rejects.toThrow();
  });
});
```
Run: `pnpm --filter @luminance/atproto test` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** — `packages/atproto/src/safe-fetch.ts`:
```ts
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export class UnsafeUrlError extends Error {}

export function isPrivateIp(ip: string): boolean {
  const addr = ipaddr.parse(ip);
  const range = addr.range();
  return range !== "unicast"; // loopback, private, linkLocal, uniqueLocal, unspecified, reserved…
}

export async function assertPublicHttps(url: string): Promise<URL> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new UnsafeUrlError(`non-https url: ${url}`);
  const host = u.hostname;
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new UnsafeUrlError(`private address for ${host}`);
  }
  return u;
}

export async function safeJsonFetch(url: string): Promise<unknown> {
  await assertPublicHttps(url);
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return res.json();
}
```
Add dep: `pnpm --filter @luminance/atproto add ipaddr.js`.

`packages/atproto/src/identity.ts`:
```ts
import { safeJsonFetch, assertPublicHttps } from "./safe-fetch.js";

type FetchJson = (url: string) => Promise<unknown>;

export async function resolvePdsEndpoint(did: string, fetchJson: FetchJson = safeJsonFetch): Promise<string> {
  let doc: any;
  if (did.startsWith("did:plc:")) {
    doc = await fetchJson(`https://plc.directory/${did}`);
  } else if (did.startsWith("did:web:")) {
    const host = decodeURIComponent(did.slice("did:web:".length));
    doc = await fetchJson(`https://${host}/.well-known/did.json`);
  } else {
    throw new Error(`unsupported did method: ${did}`);
  }
  const svc = (doc.service ?? []).find((s: any) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer");
  if (!svc) throw new Error(`no atproto_pds service in did doc for ${did}`);
  const endpoint = new URL(svc.serviceEndpoint);
  if (endpoint.protocol !== "https:") throw new Error(`pds endpoint not https for ${did}`);
  return endpoint.origin;
}
```
Note the test injects `fetchJson`, so unit tests never hit the network; `safeJsonFetch` itself enforces the guard in production paths.

- [ ] **Step 4: Run** — Expected: PASS (all SSRF + identity tests).

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "feat(atproto): SSRF-guarded fetch + DID->PDS resolution with regression tests"
```

---

### Task 5: Record mappers — shared types, clamp, Luminance (`packages/atproto`)

**Files:**
- Create: `packages/atproto/src/mappers/types.ts`, `packages/atproto/src/mappers/luminance.ts`, `packages/atproto/src/mappers/luminance.test.ts`, `packages/atproto/src/index.ts`

**Interfaces:**
- Produces: `MappedPhoto` (fields mirror `photos` insert shape, camelCase: `atUri, mediaIndex, did, source, recordCid, blobCid, width, height, alt, title, caption, capturedAt, createdAt, sortAt, exif, tags, license, labels, groupKey`); `MappedSeries { atUri, did, title, description, coverPhotoUri, createdAt, items: { photoUri: string; position: number }[] }`; `MappedProfile { did, displayName, bio, website, location, avatarCid }`; `clampSortAt(claimed: Date | null, indexedAt: Date): Date`; `mapLuminancePhoto(ctx, record): MappedPhoto | null`; `mapLuminanceSeries(ctx, record): MappedSeries | null`; `mapLuminanceProfile(did, record): MappedProfile`; `Ctx = { did: string; collection: string; rkey: string; cid: string; indexedAt: Date }`; `blobCid(blob: unknown): string | null`; `selfLabelVals(labels: unknown): string[]`.

- [ ] **Step 1: Failing tests** — `packages/atproto/src/mappers/luminance.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mapLuminancePhoto, clampSortAt } from "./luminance.js";

const ctx = { did: "did:plc:kevin", collection: "social.luminance.portfolio.photo", rkey: "3abc", cid: "bafyrec", indexedAt: new Date("2026-07-21T12:00:00Z") };
const record = {
  $type: "social.luminance.portfolio.photo",
  image: { $type: "blob", ref: { $link: "bafkimg" }, mimeType: "image/jpeg", size: 1000 },
  aspectRatio: { width: 3000, height: 2000 },
  alt: "Heron at dawn", title: "Dawn Patrol",
  capturedAt: "2026-07-01T09:30:00Z", createdAt: "2026-07-20T00:00:00Z",
  exif: { camera: "Nikon Z8", lens: "600mm f/6.3", iso: 640 },
  tags: ["wildlife"], license: "all-rights-reserved",
  labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "nudity" }] },
};

describe("clampSortAt", () => {
  const indexed = new Date("2026-07-21T12:00:00Z");
  it("passes through sane timestamps", () =>
    expect(clampSortAt(new Date("2026-07-01T00:00:00Z"), indexed).toISOString()).toBe("2026-07-01T00:00:00.000Z"));
  it("clamps future timestamps to indexedAt+10min", () =>
    expect(clampSortAt(new Date("2027-01-01T00:00:00Z"), indexed).toISOString()).toBe("2026-07-21T12:10:00.000Z"));
  it("falls back to indexedAt when null", () =>
    expect(clampSortAt(null, indexed)).toEqual(indexed));
});

describe("mapLuminancePhoto", () => {
  it("maps a full record", () => {
    const m = mapLuminancePhoto(ctx, record)!;
    expect(m).toMatchObject({
      atUri: "at://did:plc:kevin/social.luminance.portfolio.photo/3abc",
      mediaIndex: 0, source: "luminance", blobCid: "bafkimg",
      width: 3000, height: 2000, title: "Dawn Patrol",
      capturedAt: new Date("2026-07-01T09:30:00Z"),
      labels: ["nudity"], tags: ["wildlife"],
    });
    expect(m.sortAt).toEqual(new Date("2026-07-01T09:30:00Z")); // capturedAt wins
  });
  it("returns null for a record without a blob", () => {
    expect(mapLuminancePhoto(ctx, { ...record, image: undefined })).toBeNull();
  });
});
```
Run — Expected: FAIL.

- [ ] **Step 2: Implement** — `packages/atproto/src/mappers/types.ts`:
```ts
export type PhotoSource = "luminance" | "bsky" | "grain";
export interface Ctx { did: string; collection: string; rkey: string; cid: string; indexedAt: Date }
export interface MappedPhoto {
  atUri: string; mediaIndex: number; did: string; source: PhotoSource;
  recordCid: string; blobCid: string; width: number | null; height: number | null;
  alt: string | null; title: string | null; caption: string | null;
  capturedAt: Date | null; createdAt: Date | null; sortAt: Date;
  exif: Record<string, string | number> | null; tags: string[]; license: string | null;
  labels: string[]; groupKey: string | null;
}
export interface MappedSeries {
  atUri: string; did: string; title: string; description: string | null;
  coverPhotoUri: string | null; createdAt: Date | null;
  items: { photoUri: string; position: number }[];
}
export interface MappedProfile {
  did: string; displayName: string | null; bio: string | null;
  website: string | null; location: string | null; avatarCid: string | null;
}
export const atUri = (c: Ctx) => `at://${c.did}/${c.collection}/${c.rkey}`;
export function blobCid(blob: any): string | null {
  return blob?.ref?.$link ?? (typeof blob?.ref === "object" && blob.ref?.toString?.()) ?? null;
}
export function selfLabelVals(labels: any): string[] {
  if (labels?.$type !== "com.atproto.label.defs#selfLabels") return [];
  return (labels.values ?? []).map((v: any) => String(v.val)).filter(Boolean);
}
export function parseDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
```
`packages/atproto/src/mappers/luminance.ts`:
```ts
import { atUri, blobCid, selfLabelVals, parseDate, type Ctx, type MappedPhoto, type MappedSeries, type MappedProfile } from "./types.js";

const CLAMP_MS = 10 * 60 * 1000; // spec §8: 10 minutes
export function clampSortAt(claimed: Date | null, indexedAt: Date): Date {
  if (!claimed) return indexedAt;
  const max = indexedAt.getTime() + CLAMP_MS;
  return claimed.getTime() > max ? new Date(max) : claimed;
}

export function mapLuminancePhoto(ctx: Ctx, record: any): MappedPhoto | null {
  const cid = blobCid(record?.image);
  if (!cid) return null;
  const capturedAt = parseDate(record.capturedAt);
  const createdAt = parseDate(record.createdAt);
  return {
    atUri: atUri(ctx), mediaIndex: 0, did: ctx.did, source: "luminance",
    recordCid: ctx.cid, blobCid: cid,
    width: record.aspectRatio?.width ?? null, height: record.aspectRatio?.height ?? null,
    alt: record.alt ?? null, title: record.title ?? null, caption: record.caption ?? null,
    capturedAt, createdAt, sortAt: clampSortAt(capturedAt ?? createdAt, ctx.indexedAt),
    exif: record.exif ?? null, tags: record.tags ?? [], license: record.license ?? null,
    labels: selfLabelVals(record.labels), groupKey: null,
  };
}

export function mapLuminanceSeries(ctx: Ctx, record: any): MappedSeries | null {
  if (!record?.title || !Array.isArray(record?.photos)) return null;
  return {
    atUri: atUri(ctx), did: ctx.did, title: record.title, description: record.description ?? null,
    coverPhotoUri: record.coverPhoto?.uri ?? null, createdAt: parseDate(record.createdAt),
    items: record.photos.map((p: any, i: number) => ({ photoUri: p.uri, position: i })).filter((p: any) => p.photoUri),
  };
}

export function mapLuminanceProfile(did: string, record: any): MappedProfile {
  return {
    did, displayName: record?.displayName ?? null, bio: record?.bio ?? null,
    website: record?.websiteUrl ?? null, location: record?.location ?? null,
    avatarCid: blobCid(record?.avatar),
  };
}
```
`packages/atproto/src/index.ts`:
```ts
export * from "./safe-fetch.js";
export * from "./identity.js";
export * from "./mappers/types.js";
export * from "./mappers/luminance.js";
```

- [ ] **Step 3: Run** — Expected: PASS. **Step 4: Commit** `feat(atproto): luminance mappers + sort_at clamp`.

---

### Task 6: Bluesky post + profile mappers

**Files:**
- Create: `packages/atproto/src/mappers/bsky.ts`, `packages/atproto/src/mappers/bsky.test.ts`, `packages/atproto/src/mappers/fixtures/bsky-post-4img.json`, `.../bsky-post-reply.json`, `.../bsky-post-quote-media.json`
- Modify: `packages/atproto/src/index.ts` (add export)

**Interfaces:**
- Consumes: `Ctx`, `MappedPhoto`, `clampSortAt`, `blobCid`, `selfLabelVals` from Task 5.
- Produces: `mapBskyPost(ctx: Ctx, record: any): MappedPhoto[]` (empty array = skip); `mapBskyProfile(did: string, record: any): MappedProfile`.

- [ ] **Step 1: Fixtures.** Capture real post JSON: `curl "https://public.api.bsky.app/xrpc/com.atproto.repo.getRecord?repo=bsky.app&collection=app.bsky.feed.post&rkey=<any-4-image-post>"` and save `value` as `bsky-post-4img.json`. Hand-derive `bsky-post-reply.json` (add a `reply` key) and `bsky-post-quote-media.json` (`embed.$type = "app.bsky.embed.recordWithMedia"`). If offline, hand-write the 4-image fixture with the documented shape: `embed: { $type: "app.bsky.embed.images", images: [{ image: {$type:"blob", ref:{$link:"bafk1"}, mimeType:"image/jpeg", size:1}, alt: "a", aspectRatio: {width:3,height:2} }, …4 total] }`, `text`, `createdAt`, optional `labels` selfLabels.

- [ ] **Step 2: Failing tests** — `bsky.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mapBskyPost } from "./bsky.js";
import fourImg from "./fixtures/bsky-post-4img.json" with { type: "json" };
import reply from "./fixtures/bsky-post-reply.json" with { type: "json" };
import quote from "./fixtures/bsky-post-quote-media.json" with { type: "json" };

const ctx = { did: "did:plc:kevin", collection: "app.bsky.feed.post", rkey: "3xyz", cid: "bafyrec", indexedAt: new Date("2026-07-21T12:00:00Z") };
const uri = "at://did:plc:kevin/app.bsky.feed.post/3xyz";

describe("mapBskyPost", () => {
  it("maps one row per image with mediaIndex + shared groupKey", () => {
    const rows = mapBskyPost(ctx, fourImg);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.mediaIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(rows.map((r) => r.atUri))).toEqual(new Set([uri]));
    expect(rows.every((r) => r.groupKey === uri && r.source === "bsky")).toBe(true);
    expect(rows[0].caption).toBe(fourImg.text);
  });
  it("skips replies", () => expect(mapBskyPost(ctx, reply)).toEqual([]));
  it("skips quote-posts-with-media", () => expect(mapBskyPost(ctx, quote)).toEqual([]));
  it("skips posts without image embeds", () =>
    expect(mapBskyPost(ctx, { text: "hi", createdAt: "2026-01-01T00:00:00Z" })).toEqual([]));
});
```
Run — Expected: FAIL.

- [ ] **Step 3: Implement** — `bsky.ts`:
```ts
import { atUri, blobCid, selfLabelVals, parseDate, type Ctx, type MappedPhoto, type MappedProfile } from "./types.js";
import { clampSortAt } from "./luminance.js";

export function mapBskyPost(ctx: Ctx, record: any): MappedPhoto[] {
  if (record?.reply) return []; // conversation, not portfolio (spec §7)
  if (record?.embed?.$type !== "app.bsky.embed.images") return []; // also excludes recordWithMedia (v1)
  const uri = atUri(ctx);
  const createdAt = parseDate(record.createdAt);
  const labels = selfLabelVals(record.labels);
  const rows: MappedPhoto[] = [];
  (record.embed.images ?? []).forEach((img: any, i: number) => {
    const cid = blobCid(img?.image);
    if (!cid) return;
    rows.push({
      atUri: uri, mediaIndex: i, did: ctx.did, source: "bsky", recordCid: ctx.cid, blobCid: cid,
      width: img.aspectRatio?.width ?? null, height: img.aspectRatio?.height ?? null,
      alt: img.alt || null, title: null, caption: record.text || null,
      capturedAt: null, createdAt, sortAt: clampSortAt(createdAt, ctx.indexedAt),
      exif: null, tags: [], license: null, labels, groupKey: uri,
    });
  });
  return rows;
}

export function mapBskyProfile(did: string, record: any): MappedProfile {
  return {
    did, displayName: record?.displayName ?? null, bio: record?.description ?? null,
    website: null, location: null, avatarCid: blobCid(record?.avatar),
  };
}
```
Add `export * from "./mappers/bsky.js";` to `index.ts`.

- [ ] **Step 4: Run** — Expected: PASS. **Step 5: Commit** `feat(atproto): bsky post/profile mappers with skip rules`.

---

### Task 7: Grain mappers (verify-then-map)

**Files:**
- Create: `packages/atproto/src/mappers/grain.ts`, `grain.test.ts`, `packages/atproto/src/mappers/fixtures/grain-photo.json`, `.../grain-gallery.json`, `.../grain-gallery-item.json`

**Interfaces:**
- Consumes: Task 5 types.
- Produces: `GRAIN_COLLECTIONS: string[]` (exact NSIDs, discovered in Step 1); `mapGrainRecord(ctx: Ctx, record: any): { photo?: MappedPhoto; series?: MappedSeries; seriesItem?: { seriesUri: string; photoUri: string; position: number } } | null`.

- [ ] **Step 1: Verify Grain's real lexicons (spec §7 caveat — this step is mandatory, not optional).** Fetch the lexicon directory of https://github.com/grainsocial/grain (look under `lexicons/`). Record the exact NSIDs for: photo record, gallery record, gallery-membership record, and their field names (blob field, alt, title, gallery ref, position/sort field). Save one real example of each (from `com.atproto.repo.listRecords` against any public Grain user, e.g. resolve `grain.social`'s own account) into the three fixture files. **All code in Steps 2–3 must be adjusted to the verified shapes — the shapes below are the expected pattern, not gospel.**

- [ ] **Step 2: Failing tests** — `grain.test.ts` (written against the verified fixtures):
```ts
import { describe, it, expect } from "vitest";
import { mapGrainRecord, GRAIN_COLLECTIONS } from "./grain.js";
import photo from "./fixtures/grain-photo.json" with { type: "json" };
import gallery from "./fixtures/grain-gallery.json" with { type: "json" };
import item from "./fixtures/grain-gallery-item.json" with { type: "json" };

describe("mapGrainRecord", () => {
  it("declares the verified collection NSIDs", () => {
    expect(GRAIN_COLLECTIONS.length).toBeGreaterThanOrEqual(2);
    expect(GRAIN_COLLECTIONS.every((c) => c.startsWith("social.grain."))).toBe(true);
  });
  it("maps a grain photo to MappedPhoto with source=grain, mediaIndex 0", () => {
    const ctx = { did: "did:plc:g", collection: GRAIN_COLLECTIONS[0], rkey: "1", cid: "c", indexedAt: new Date() };
    const m = mapGrainRecord(ctx, photo)!;
    expect(m.photo).toMatchObject({ source: "grain", mediaIndex: 0 });
    expect(m.photo!.blobCid).toBeTruthy();
  });
  it("maps gallery + membership records to series structures", () => {
    const gctx = { did: "did:plc:g", collection: GRAIN_COLLECTIONS[1], rkey: "2", cid: "c", indexedAt: new Date() };
    expect(mapGrainRecord(gctx, gallery)!.series).toBeTruthy();
    const ictx = { did: "did:plc:g", collection: GRAIN_COLLECTIONS[2] ?? GRAIN_COLLECTIONS[1], rkey: "3", cid: "c", indexedAt: new Date() };
    const si = mapGrainRecord(ictx, item);
    if (GRAIN_COLLECTIONS.length > 2) expect(si!.seriesItem).toBeTruthy();
  });
});
```

- [ ] **Step 3: Implement `grain.ts`** against verified shapes (expected pattern):
```ts
import { atUri, blobCid, selfLabelVals, parseDate, type Ctx, type MappedPhoto, type MappedSeries } from "./types.js";
import { clampSortAt } from "./luminance.js";

// VERIFIED against grainsocial/grain lexicons on <date> — update if they version.
export const GRAIN_PHOTO = "social.grain.photo";
export const GRAIN_GALLERY = "social.grain.gallery";
export const GRAIN_GALLERY_ITEM = "social.grain.gallery.item";
export const GRAIN_COLLECTIONS = [GRAIN_PHOTO, GRAIN_GALLERY, GRAIN_GALLERY_ITEM];

export function mapGrainRecord(ctx: Ctx, record: any) {
  if (ctx.collection === GRAIN_PHOTO) {
    const cid = blobCid(record?.photo ?? record?.image);
    if (!cid) return null;
    const createdAt = parseDate(record.createdAt);
    const photo: MappedPhoto = {
      atUri: atUri(ctx), mediaIndex: 0, did: ctx.did, source: "grain", recordCid: ctx.cid, blobCid: cid,
      width: record.aspectRatio?.width ?? null, height: record.aspectRatio?.height ?? null,
      alt: record.alt ?? null, title: null, caption: null, capturedAt: null, createdAt,
      sortAt: clampSortAt(createdAt, ctx.indexedAt), exif: null, tags: [], license: null,
      labels: selfLabelVals(record.labels), groupKey: null,
    };
    return { photo };
  }
  if (ctx.collection === GRAIN_GALLERY) {
    const series: MappedSeries = {
      atUri: atUri(ctx), did: ctx.did, title: record?.title ?? "Untitled",
      description: record?.description ?? null, coverPhotoUri: null,
      createdAt: parseDate(record?.createdAt), items: [],
    };
    return { series };
  }
  if (ctx.collection === GRAIN_GALLERY_ITEM) {
    if (!record?.gallery || !record?.item) return null;
    return { seriesItem: { seriesUri: record.gallery.uri ?? record.gallery, photoUri: record.item.uri ?? record.item, position: record.position ?? 0 } };
  }
  return null;
}
```
Export from `index.ts`.

- [ ] **Step 4: Run** — Expected: PASS with real fixtures. **Step 5: Commit** `feat(atproto): grain mappers against verified lexicons` (commit message must name the verified NSIDs).

---

### Task 8: Ingestor scaffold + indexer writes

**Files:**
- Create: `apps/ingestor/package.json`, `tsconfig.json`, `apps/ingestor/src/config.ts`, `apps/ingestor/src/indexer.ts`, `apps/ingestor/src/indexer.test.ts`, `apps/ingestor/src/health.ts`, `apps/ingestor/Dockerfile`, `apps/ingestor/fly.toml`

**Interfaces:**
- Consumes: all mappers, `createTestDb`, db tables.
- Produces: `Indexer` class with `handleEvent(evt: JetstreamEvent): Promise<void>` and `applyPhotoRows(rows: MappedPhoto[]): Promise<void>`; `JetstreamEvent` type: `{ did: string; time_us: number; kind: "commit" | "identity" | "account"; commit?: { operation: "create" | "update" | "delete"; collection: string; rkey: string; cid?: string; record?: unknown }; identity?: { handle?: string }; account?: { active: boolean; status?: string } }`.

- [ ] **Step 1: Package** — name `ingestor`, deps: `@luminance/db@workspace:*`, `@luminance/atproto@workspace:*`, `@luminance/lexicons@workspace:*`, `ws`; devDeps `@types/ws`. Scripts: `build: tsc`, `start: node dist/main.js`, `test: vitest run`, `typecheck`.

- [ ] **Step 2: Failing indexer tests** — `indexer.test.ts` (PGlite; the behavioral heart of the AppView — spec §9):
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, photos, photographers, tombstones, photoOverrides } from "@luminance/db";
import { Indexer } from "./indexer.js";

const DID = "did:plc:kevin";
const photoEvt = (rkey: string, op: "create" | "delete" = "create") => ({
  did: DID, time_us: 1, kind: "commit" as const,
  commit: { operation: op, collection: "social.luminance.portfolio.photo", rkey, cid: "bafyrec",
    record: op === "create" ? { image: { $type: "blob", ref: { $link: `bafk-${rkey}` }, mimeType: "image/jpeg", size: 1 }, createdAt: "2026-07-01T00:00:00Z" } : undefined },
});

describe("Indexer", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let ix: Indexer;
  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "klee.photos" });
    ix = new Indexer(db);
  });
  it("indexes a luminance photo create", async () => {
    await ix.handleEvent(photoEvt("p1"));
    expect((await db.select().from(photos))).toHaveLength(1);
  });
  it("upsert is idempotent (replay-safe)", async () => {
    await ix.handleEvent(photoEvt("p1"));
    await ix.handleEvent(photoEvt("p1"));
    expect((await db.select().from(photos))).toHaveLength(1);
  });
  it("delete removes all rows for the AT-URI and tombstones during active backfill", async () => {
    await ix.handleEvent(photoEvt("p1"));
    await db.update(photographers).set({ backfillStatus: "running" });
    await ix.handleEvent(photoEvt("p1", "delete"));
    expect(await db.select().from(photos)).toHaveLength(0);
    expect(await db.select().from(tombstones)).toHaveLength(1);
  });
  it("ignores events from unregistered DIDs", async () => {
    await ix.handleEvent({ ...photoEvt("p1"), did: "did:plc:stranger" });
    expect(await db.select().from(photos)).toHaveLength(0);
  });
  it("skips invalid records without throwing", async () => {
    const evt = photoEvt("bad");
    (evt.commit as any).record = { nope: true };
    await expect(ix.handleEvent(evt)).resolves.toBeUndefined();
    expect(await db.select().from(photos)).toHaveLength(0);
    expect(ix.stats.skipped).toBe(1);
  });
  it("account deactivation hides the photographer", async () => {
    await ix.handleEvent({ did: DID, time_us: 2, kind: "account", account: { active: false, status: "deactivated" } });
    const [row] = await db.select().from(photographers);
    expect(row.status).toBe("deactivated");
  });
  it("identity event refreshes handle", async () => {
    await ix.handleEvent({ did: DID, time_us: 3, kind: "identity", identity: { handle: "new.example.com" } });
    const [row] = await db.select().from(photographers);
    expect(row.handle).toBe("new.example.com");
  });
});
```
Run — Expected: FAIL.

- [ ] **Step 3: Implement** — `apps/ingestor/src/indexer.ts`:
```ts
import { eq, inArray, sql } from "drizzle-orm";
import { photos, series, seriesPhotos, photographers, tombstones, type Db } from "@luminance/db";
import {
  mapLuminancePhoto, mapLuminanceSeries, mapLuminanceProfile, mapBskyPost, mapBskyProfile,
  mapGrainRecord, GRAIN_COLLECTIONS, type Ctx, type MappedPhoto, type MappedSeries,
} from "@luminance/atproto";
import { LUMINANCE_PHOTO, LUMINANCE_SERIES, LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE } from "@luminance/lexicons";

export interface JetstreamEvent {
  did: string; time_us: number; kind: "commit" | "identity" | "account";
  commit?: { operation: "create" | "update" | "delete"; collection: string; rkey: string; cid?: string; record?: unknown };
  identity?: { handle?: string };
  account?: { active: boolean; status?: string };
}

export class Indexer {
  stats = { indexed: 0, skipped: 0, deleted: 0 };
  constructor(private db: Db) {}

  async handleEvent(evt: JetstreamEvent): Promise<void> {
    const [ph] = await this.db.select().from(photographers).where(eq(photographers.did, evt.did));
    if (!ph) return; // opt-in only (spec §3)

    if (evt.kind === "identity") {
      if (evt.identity?.handle) await this.db.update(photographers).set({ handle: evt.identity.handle }).where(eq(photographers.did, evt.did));
      return;
    }
    if (evt.kind === "account") {
      const status = evt.account?.active ? "active" : (evt.account?.status === "takendown" ? "takedown" : "deactivated");
      await this.db.update(photographers).set({ status: status as any }).where(eq(photographers.did, evt.did));
      return;
    }
    if (evt.kind !== "commit" || !evt.commit) return;
    const c = evt.commit;
    const uri = `at://${evt.did}/${c.collection}/${c.rkey}`;

    if (c.operation === "delete") {
      await this.db.delete(photos).where(eq(photos.atUri, uri));
      await this.db.delete(series).where(eq(series.atUri, uri));
      await this.db.delete(seriesPhotos).where(eq(seriesPhotos.seriesUri, uri));
      if (ph.backfillStatus === "running") {
        await this.db.insert(tombstones).values({ atUri: uri }).onConflictDoNothing(); // spec §9 race guard
      }
      this.stats.deleted++;
      return;
    }

    const ctx: Ctx = { did: evt.did, collection: c.collection, rkey: c.rkey, cid: c.cid ?? "", indexedAt: new Date() };
    try {
      if (c.collection === LUMINANCE_PHOTO) {
        const m = mapLuminancePhoto(ctx, c.record);
        if (!m) return void this.stats.skipped++;
        await this.applyPhotoRows([m]);
      } else if (c.collection === LUMINANCE_SERIES) {
        const m = mapLuminanceSeries(ctx, c.record);
        if (!m) return void this.stats.skipped++;
        await this.applySeries(m);
      } else if (c.collection === LUMINANCE_PROFILE) {
        const p = mapLuminanceProfile(evt.did, c.record);
        await this.db.update(photographers).set({ displayName: p.displayName, bio: p.bio, website: p.website, location: p.location, avatarCid: p.avatarCid }).where(eq(photographers.did, evt.did));
      } else if (c.collection === BSKY_POST) {
        if (!ph.includeBsky) return;
        await this.applyPhotoRows(mapBskyPost(ctx, c.record));
      } else if (c.collection === BSKY_PROFILE) {
        // fallback precedence: only fill blanks (spec §7)
        const p = mapBskyProfile(evt.did, c.record);
        await this.db.update(photographers).set({
          displayName: sql`coalesce(${photographers.displayName}, ${p.displayName})`,
          avatarCid: sql`coalesce(${photographers.avatarCid}, ${p.avatarCid})`,
        }).where(eq(photographers.did, evt.did));
      } else if (GRAIN_COLLECTIONS.includes(c.collection)) {
        if (!ph.includeGrain) return;
        const m = mapGrainRecord(ctx, c.record);
        if (!m) return void this.stats.skipped++;
        if (m.photo) await this.applyPhotoRows([m.photo]);
        if (m.series) await this.applySeries(m.series);
        if (m.seriesItem) await this.db.insert(seriesPhotos).values({ seriesUri: m.seriesItem.seriesUri, photoUri: m.seriesItem.photoUri, position: m.seriesItem.position }).onConflictDoUpdate({ target: [seriesPhotos.seriesUri, seriesPhotos.photoUri], set: { position: m.seriesItem.position } });
      }
    } catch (err) {
      this.stats.skipped++; // poison event costs one photo, never the stream (spec §12)
      console.error("indexer: skipped event", { uri, err: String(err) });
    }
  }

  async applyPhotoRows(rows: MappedPhoto[], opts: { respectTombstones?: boolean } = {}) {
    if (!rows.length) return;
    if (opts.respectTombstones) {
      const ts = await this.db.select().from(tombstones).where(inArray(tombstones.atUri, rows.map((r) => r.atUri)));
      const dead = new Set(ts.map((t) => t.atUri));
      rows = rows.filter((r) => !dead.has(r.atUri));
      if (!rows.length) return;
    }
    await this.db.insert(photos).values(rows.map((r) => ({
      atUri: r.atUri, mediaIndex: r.mediaIndex, did: r.did, source: r.source, recordCid: r.recordCid,
      blobCid: r.blobCid, width: r.width, height: r.height, alt: r.alt, title: r.title, caption: r.caption,
      capturedAt: r.capturedAt, createdAt: r.createdAt, sortAt: r.sortAt, exif: r.exif, tags: r.tags,
      license: r.license, labels: r.labels, groupKey: r.groupKey,
    }))).onConflictDoUpdate({
      target: [photos.atUri, photos.mediaIndex],
      set: { recordCid: sql`excluded.record_cid`, blobCid: sql`excluded.blob_cid`, alt: sql`excluded.alt`,
        title: sql`excluded.title`, caption: sql`excluded.caption`, sortAt: sql`excluded.sort_at`,
        exif: sql`excluded.exif`, tags: sql`excluded.tags`, labels: sql`excluded.labels` },
    });
    this.stats.indexed += rows.length;
  }

  private async applySeries(m: MappedSeries) {
    await this.db.insert(series).values({ atUri: m.atUri, did: m.did, title: m.title, description: m.description, coverPhotoUri: m.coverPhotoUri, createdAt: m.createdAt })
      .onConflictDoUpdate({ target: series.atUri, set: { title: sql`excluded.title`, description: sql`excluded.description`, coverPhotoUri: sql`excluded.cover_photo_uri` } });
    if (m.items.length) {
      await this.db.delete(seriesPhotos).where(eq(seriesPhotos.seriesUri, m.atUri));
      await this.db.insert(seriesPhotos).values(m.items.map((i) => ({ seriesUri: m.atUri, photoUri: i.photoUri, position: i.position })));
    }
  }
}
```
`health.ts`: tiny `node:http` server returning `{ ok: true, stats }` on `:8080/health`.
`Dockerfile`: `FROM node:24-slim`, corepack enable, copy workspace, `pnpm install --frozen-lockfile`, `pnpm --filter ingestor... build`, `CMD ["node", "apps/ingestor/dist/main.js"]`. `fly.toml`: app `luminance-ingestor`, `[http_service] internal_port = 8080`, health check GET `/health`.

- [ ] **Step 4: Run** — `pnpm --filter ingestor test` — Expected: PASS (7 tests). **Step 5: Commit** `feat(ingestor): event indexer with tombstones, account/identity handling`.

---

### Task 9: Jetstream connection manager

**Files:**
- Create: `apps/ingestor/src/jetstream.ts`, `apps/ingestor/src/jetstream.test.ts`, `apps/ingestor/src/main.ts`, `apps/ingestor/src/config.ts`

**Interfaces:**
- Consumes: `Indexer.handleEvent`, `ingestCursors` table.
- Produces: `JetstreamConsumer` class: `new JetstreamConsumer({ db, url, connectionId, collections, getDids, onEvent, onStaleCursor, replayWindowUs? })`, methods `start()`, `stop()`, `refreshDids()` (re-sends `options_update`). Cursor commits **after** `onEvent` resolves (batch of 1 in v1 — the contract, not the batch size, is what matters).

- [ ] **Step 1: Failing tests** — `jetstream.test.ts` (spin a local `ws` server as a fake Jetstream):
```ts
import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { createTestDb, ingestCursors } from "@luminance/db";
import { JetstreamConsumer } from "./jetstream.js";

let wss: WebSocketServer; let consumer: JetstreamConsumer;
afterEach(async () => { await consumer?.stop(); wss?.close(); });

function fakeJetstream(onConn?: (url: string) => void) {
  wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws, req) => { onConn?.(req.url!); (wss as any).lastSocket = ws; });
  const port = (wss.address() as any).port;
  return `ws://127.0.0.1:${port}`;
}

describe("JetstreamConsumer", () => {
  it("delivers events and advances the cursor only after handling", async () => {
    const db = await createTestDb();
    const url = fakeJetstream();
    const seen: number[] = [];
    consumer = new JetstreamConsumer({
      db, url, connectionId: "main", collections: ["social.luminance.portfolio.photo"],
      getDids: async () => ["did:plc:kevin"],
      onEvent: async (e) => { seen.push(e.time_us); },
      onStaleCursor: async () => {},
    });
    await consumer.start();
    (wss as any).lastSocket.send(JSON.stringify({ did: "did:plc:kevin", time_us: 111, kind: "commit", commit: { operation: "create", collection: "social.luminance.portfolio.photo", rkey: "r", record: {} } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual([111]);
    const [cur] = await db.select().from(ingestCursors);
    expect(cur.timeUs).toBe(111n);
  });
  it("includes cursor and filters in the subscribe URL", async () => {
    const db = await createTestDb();
    await db.insert(ingestCursors).values({ connectionId: "main", timeUs: 999_000_000n });
    let seenUrl = "";
    const url = fakeJetstream((u) => { seenUrl = u; });
    consumer = new JetstreamConsumer({ db, url, connectionId: "main", collections: ["a.b.c"], getDids: async () => ["did:plc:x"], onEvent: async () => {}, onStaleCursor: async () => {} });
    await consumer.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(seenUrl).toContain("cursor=994000000"); // stored cursor minus 5s overlap
    expect(seenUrl).toContain("wantedCollections=a.b.c");
    expect(seenUrl).toContain("wantedDids=did%3Aplc%3Ax");
  });
  it("fires onStaleCursor when stored cursor is older than the replay window", async () => {
    const db = await createTestDb();
    await db.insert(ingestCursors).values({ connectionId: "main", timeUs: 1n }); // ancient
    let stale = false;
    const url = fakeJetstream();
    consumer = new JetstreamConsumer({ db, url, connectionId: "main", collections: [], getDids: async () => [], onEvent: async () => {}, onStaleCursor: async () => { stale = true; }, replayWindowUs: 1000n });
    await consumer.start();
    expect(stale).toBe(true);
  });
});
```
Run — Expected: FAIL.

- [ ] **Step 2: Implement** — `jetstream.ts`:
```ts
import WebSocket from "ws";
import { eq } from "drizzle-orm";
import { ingestCursors, type Db } from "@luminance/db";
import type { JetstreamEvent } from "./indexer.js";

interface Opts {
  db: Db; url: string; connectionId: string; collections: string[];
  getDids: () => Promise<string[]>;
  onEvent: (e: JetstreamEvent) => Promise<void>;
  onStaleCursor: () => Promise<void>;
  replayWindowUs?: bigint; // default 48h
}

export class JetstreamConsumer {
  private ws?: WebSocket; private stopped = false; private backoffMs = 1000;
  private didPoll?: ReturnType<typeof setInterval>; private lastDids = "";
  constructor(private o: Opts) {}

  async start() {
    const cursor = await this.readCursor();
    const windowUs = this.o.replayWindowUs ?? 48n * 3600n * 1_000_000n;
    if (cursor !== null && BigInt(Date.now()) * 1000n - cursor > windowUs) {
      await this.o.onStaleCursor(); // reconciliation backfill (spec §9)
    }
    await this.connect(cursor);
    this.didPoll = setInterval(() => void this.pushDidUpdate(), 30_000); // spec §9: ~30s registry poll
  }

  private async readCursor(): Promise<bigint | null> {
    const [row] = await this.o.db.select().from(ingestCursors).where(eq(ingestCursors.connectionId, this.o.connectionId));
    return row?.timeUs ?? null;
  }

  private async connect(cursor: bigint | null) {
    const dids = await this.o.getDids();
    this.lastDids = JSON.stringify(dids);
    const u = new URL(this.o.url);
    u.pathname = "/subscribe";
    for (const c of this.o.collections) u.searchParams.append("wantedCollections", c);
    for (const d of dids) u.searchParams.append("wantedDids", d);
    if (cursor !== null) u.searchParams.set("cursor", String(cursor > 5_000_000n ? cursor - 5_000_000n : 0n)); // 5s replay overlap; idempotent upserts make it harmless (spec §9)
    this.ws = new WebSocket(u.toString());
    this.ws.on("open", () => { this.backoffMs = 1000; });
    this.ws.on("message", (data) => void this.handleMessage(data.toString()));
    this.ws.on("close", () => void this.reconnect());
    this.ws.on("error", () => this.ws?.close());
  }

  private queue: Promise<void> = Promise.resolve();
  private handleMessage(raw: string) {
    this.queue = this.queue.then(async () => {
      let evt: JetstreamEvent & { time_us: number };
      try { evt = JSON.parse(raw); } catch { return; }
      await this.o.onEvent(evt);
      await this.o.db.insert(ingestCursors)
        .values({ connectionId: this.o.connectionId, timeUs: BigInt(evt.time_us) })
        .onConflictDoUpdate({ target: ingestCursors.connectionId, set: { timeUs: BigInt(evt.time_us), updatedAt: new Date() } });
    }).catch((err) => console.error("jetstream: handler error", err)); // cursor NOT advanced on failure
  }

  private async pushDidUpdate() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const dids = await this.o.getDids();
    const j = JSON.stringify(dids);
    if (j === this.lastDids) return;
    this.lastDids = j;
    this.ws.send(JSON.stringify({ type: "options_update", payload: { wantedCollections: this.o.collections, wantedDids: dids } }));
  }
  refreshDids() { this.lastDids = ""; void this.pushDidUpdate(); }

  private async reconnect() {
    if (this.stopped) return;
    await new Promise((r) => setTimeout(r, this.backoffMs + Math.random() * 500));
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    await this.connect(await this.readCursor());
  }

  async stop() { this.stopped = true; clearInterval(this.didPoll); this.ws?.close(); await this.queue; }
}
```
`config.ts`: read env (`DATABASE_URL`, `JETSTREAM_URL` default `wss://jetstream2.us-east.bsky.network`, `HEALTH_PORT` default 8080), throw on missing `DATABASE_URL`.
`main.ts`: wire `createDb` → `Indexer` → `JetstreamConsumer` (collections: `[LUMINANCE_PHOTO, LUMINANCE_SERIES, LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE, ...GRAIN_COLLECTIONS]`; `getDids` selects non-deregistered photographer DIDs) + backfill runner (Task 10) + health server; `onStaleCursor` marks all photographers `backfillStatus='pending'`.

- [ ] **Step 3: Run** — Expected: PASS (3 tests). **Step 4: Commit** `feat(ingestor): jetstream consumer with cursor discipline, backoff, options_update`.

---

### Task 10: Backfill runner

**Files:**
- Create: `apps/ingestor/src/backfill.ts`, `apps/ingestor/src/backfill.test.ts`
- Modify: `apps/ingestor/src/main.ts` (start loop)

**Interfaces:**
- Consumes: `Indexer.applyPhotoRows` (with `respectTombstones: true`), mappers, `resolvePdsEndpoint`.
- Produces: `runBackfill(db, indexer, did, opts?: { fetchJson?; resolvePds?; maxPerCollection? }): Promise<void>` — walks all watched collections via `com.atproto.repo.listRecords` (pages of 100, newest first), maps + applies rows, caps at 5,000/collection, prunes tombstones, sets `backfillStatus` `running→complete|failed`; `startBackfillLoop(db, indexer, intervalMs)` — polls for `pending` photographers.

- [ ] **Step 1: Failing tests** — `backfill.test.ts` (mock PDS via injected `fetchJson`; includes the **delete-race regression**, spec §13):
```ts
import { describe, it, expect } from "vitest";
import { createTestDb, photos, photographers, tombstones } from "@luminance/db";
import { eq } from "drizzle-orm";
import { Indexer } from "./indexer.js";
import { runBackfill } from "./backfill.js";

const DID = "did:plc:kevin";
const rec = (rkey: string) => ({
  uri: `at://${DID}/social.luminance.portfolio.photo/${rkey}`, cid: "bafyrec",
  value: { $type: "social.luminance.portfolio.photo", image: { $type: "blob", ref: { $link: `bafk-${rkey}` }, mimeType: "image/jpeg", size: 1 }, createdAt: "2026-07-01T00:00:00Z" },
});
// fake PDS: only the luminance photo collection has records
const fetchJson = async (url: string) => {
  const u = new URL(url);
  if (u.pathname.endsWith("/xrpc/com.atproto.repo.listRecords") && u.searchParams.get("collection") === "social.luminance.portfolio.photo" && !u.searchParams.get("cursor")) {
    return { records: [rec("p1"), rec("p2")], cursor: undefined };
  }
  return { records: [] };
};
const resolvePds = async () => "https://pds.example.com";

describe("runBackfill", () => {
  it("indexes repo history and marks complete", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "klee.photos" });
    await runBackfill(db, new Indexer(db), DID, { fetchJson, resolvePds });
    expect(await db.select().from(photos)).toHaveLength(2);
    const [ph] = await db.select().from(photographers);
    expect(ph.backfillStatus).toBe("complete");
  });
  it("does not resurrect a record deleted mid-backfill (tombstone) and prunes tombstones after", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "klee.photos", backfillStatus: "running" });
    await db.insert(tombstones).values({ atUri: rec("p1").uri }); // live delete arrived first
    await runBackfill(db, new Indexer(db), DID, { fetchJson, resolvePds });
    const rows = await db.select().from(photos);
    expect(rows.map((r) => r.atUri)).toEqual([rec("p2").uri]); // p1 stayed dead
    expect(await db.select().from(tombstones)).toHaveLength(0); // pruned on completion
  });
  it("marks failed when the PDS is unreachable", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "klee.photos" });
    await runBackfill(db, new Indexer(db), DID, { fetchJson: async () => { throw new Error("down"); }, resolvePds, maxAttempts: 2, retryDelayMs: 1 });
    const [ph] = await db.select().from(photographers);
    expect(ph.backfillStatus).toBe("failed");
  });
});
```
Run — Expected: FAIL.

- [ ] **Step 2: Implement** — `backfill.ts`:
```ts
import { eq, like } from "drizzle-orm";
import { photographers, tombstones, type Db } from "@luminance/db";
import { resolvePdsEndpoint as realResolve, safeJsonFetch, mapLuminancePhoto, mapLuminanceSeries, mapLuminanceProfile, mapBskyPost, mapBskyProfile, mapGrainRecord, GRAIN_COLLECTIONS, type Ctx } from "@luminance/atproto";
import { LUMINANCE_PHOTO, LUMINANCE_SERIES, LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE } from "@luminance/lexicons";
import type { Indexer } from "./indexer.js";

const MAX_PER_COLLECTION = 5000; // spec §9
const WATCHED = [LUMINANCE_PHOTO, LUMINANCE_SERIES, LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE, ...GRAIN_COLLECTIONS];

export async function runBackfill(db: Db, indexer: Indexer, did: string, opts: {
  fetchJson?: (url: string) => Promise<unknown>; resolvePds?: (did: string) => Promise<string>;
  maxPerCollection?: number; maxAttempts?: number; retryDelayMs?: number;
} = {}) {
  const fetchJson = opts.fetchJson ?? safeJsonFetch;
  const resolvePds = opts.resolvePds ?? realResolve;
  const cap = opts.maxPerCollection ?? MAX_PER_COLLECTION;
  const attempts = opts.maxAttempts ?? 5;
  await db.update(photographers).set({ backfillStatus: "running" }).where(eq(photographers.did, did));
  try {
    let pds = "";
    for (let a = 1; ; a++) {
      try { pds = await resolvePds(did); break; }
      catch (e) { if (a >= attempts) throw e; await sleep(opts.retryDelayMs ?? 1000 * 2 ** a); }
    }
    for (const collection of WATCHED) {
      let cursor: string | undefined; let count = 0;
      do {
        const u = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`);
        u.searchParams.set("repo", did); u.searchParams.set("collection", collection); u.searchParams.set("limit", "100");
        if (cursor) u.searchParams.set("cursor", cursor);
        let page: any;
        for (let a = 1; ; a++) {
          try { page = await fetchJson(u.toString()); break; }
          catch (e) { if (a >= attempts) throw e; await sleep(opts.retryDelayMs ?? 1000 * 2 ** a); }
        }
        for (const r of page.records ?? []) {
          const rkey = String(r.uri).split("/").pop()!;
          const ctx: Ctx = { did, collection, rkey, cid: r.cid, indexedAt: new Date() };
          await applyOne(db, indexer, ctx, r.value);
          count++;
        }
        cursor = page.cursor;
        await sleep(opts.retryDelayMs ?? 250); // throttle (spec §9)
      } while (cursor && count < cap);
    }
    await db.delete(tombstones).where(like(tombstones.atUri, `at://${did}/%`)); // prune only this DID's tombstones — concurrent backfills of other DIDs must keep theirs (spec §9)
    await db.update(photographers).set({ backfillStatus: "complete" }).where(eq(photographers.did, did));
  } catch (err) {
    console.error("backfill failed", { did, err: String(err) });
    await db.update(photographers).set({ backfillStatus: "failed" }).where(eq(photographers.did, did));
  }
}

async function applyOne(db: Db, indexer: Indexer, ctx: Ctx, record: any) {
  const { collection } = ctx;
  if (collection === LUMINANCE_PHOTO) { const m = mapLuminancePhoto(ctx, record); if (m) await indexer.applyPhotoRows([m], { respectTombstones: true }); }
  else if (collection === BSKY_POST) { await indexer.applyPhotoRows(mapBskyPost(ctx, record), { respectTombstones: true }); }
  else if (GRAIN_COLLECTIONS.includes(collection)) {
    const m = mapGrainRecord(ctx, record);
    if (m?.photo) await indexer.applyPhotoRows([m.photo], { respectTombstones: true });
    // series/items reuse the live-path handlers:
    if (m?.series || m?.seriesItem) await indexer.handleEvent({ did: ctx.did, time_us: 0, kind: "commit", commit: { operation: "create", collection, rkey: ctx.rkey, cid: ctx.cid, record } });
  }
  else await indexer.handleEvent({ did: ctx.did, time_us: 0, kind: "commit", commit: { operation: "create", collection, rkey: ctx.rkey, cid: ctx.cid, record } });
}

export function startBackfillLoop(db: Db, indexer: Indexer, intervalMs = 10_000) {
  return setInterval(async () => {
    const pending = await db.select().from(photographers).where(eq(photographers.backfillStatus, "pending"));
    for (const p of pending) await runBackfill(db, indexer, p.did);
  }, intervalMs);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```
Note: source-toggle filtering happens inside `Indexer.handleEvent`/mapper application (bsky rows skipped when `includeBsky=false`) — `applyOne` routes through the same rules; verify with the toggle test in Task 8 if extending.

- [ ] **Step 3: Run** — Expected: PASS (3 tests, incl. the race regression). **Step 4: Commit** `feat(ingestor): backfill with caps, throttle, retry, tombstone pruning`.

---

### Task 11: Web app scaffold (`apps/web`)

**Files:**
- Create: `apps/web/package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/web/app/page.tsx` (placeholder), `apps/web/app/about/page.tsx`, `apps/web/app/dmca/page.tsx`, `apps/web/lib/db.ts`, `apps/web/lib/env.ts`, `apps/web/.env.example`

**Interfaces:**
- Produces: `getDb()` singleton (`apps/web/lib/db.ts`); `env` object validating `DATABASE_URL`, `PUBLIC_URL`, `SESSION_SECRET`, `ADMIN_DIDS` at boot. Route-name rule: **every new top-level route segment must be dotless** (global constraint).

- [ ] **Step 1: Scaffold.** `pnpm create next-app@latest apps/web --ts --app --tailwind --no-eslint --no-src-dir --import-alias "@/*"`, then set package name `web`, add `@luminance/db@workspace:*`, `@luminance/atproto@workspace:*`, `@luminance/lexicons@workspace:*`. `lib/db.ts`:
```ts
import { createDb, type Db } from "@luminance/db";
import { env } from "./env";
let db: Db | undefined;
export function getDb(): Db { return (db ??= createDb(env.DATABASE_URL)); }
```
`lib/env.ts`:
```ts
const req = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };
export const env = {
  get DATABASE_URL() { return req("DATABASE_URL"); },
  get PUBLIC_URL() { return req("PUBLIC_URL"); },
  get SESSION_SECRET() { return req("SESSION_SECRET"); },
  get ADMIN_DIDS() { return (process.env.ADMIN_DIDS ?? "").split(",").filter(Boolean); },
};
```
`app/dmca/page.tsx` and `app/about/page.tsx`: static prose pages — DMCA page must include a working contact email and the required elements of a takedown notice (counter-notice mention included). `.env.example` lists every env var from Global Constraints with placeholder values.

- [ ] **Step 2: Verify** — `pnpm --filter web build` — Expected: build succeeds. **Step 3: Commit** `feat(web): next.js scaffold, db wiring, about/dmca pages`.

---

### Task 12: Image proxy route

**Files:**
- Create: `apps/web/app/img/[did]/[cid]/[preset]/route.ts`, `apps/web/lib/image-proxy.ts`, `apps/web/lib/image-proxy.test.ts`
- Modify: `apps/web/package.json` (add `sharp`)

**Interfaces:**
- Consumes: `photos.blobCid` / `photographers.avatarCid` allowlist, `resolvePdsEndpoint`, `assertPublicHttps`.
- Produces: `PRESETS = { thumb: 512, feed: 1024, full: 2048 }`; `proxyImage(db, { did, cid, preset, accept }): Promise<{ status: number; body?: Buffer; contentType?: string; cacheControl: string }>` — pure function the route handler wraps, injectable fetchers for tests.

- [ ] **Step 1: Failing tests** — `image-proxy.test.ts` (spec §11/§13 security regression fixtures):
```ts
import { describe, it, expect } from "vitest";
import { createTestDb, photos, photographers } from "@luminance/db";
import { proxyImage } from "./image-proxy";

const seed = async (db: any) => {
  await db.insert(photographers).values({ did: "did:plc:a", handle: "klee.photos", avatarCid: "bafk-avatar" });
  await db.insert(photos).values({ atUri: "at://did:plc:a/c/1", mediaIndex: 0, did: "did:plc:a", source: "luminance", recordCid: "r", blobCid: "bafk-photo", sortAt: new Date() });
};

describe("image proxy", () => {
  it("404s for a blob the index does not reference — before any fetch", async () => {
    const db = await createTestDb(); await seed(db);
    let fetched = false;
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-unknown", preset: "feed", accept: "image/webp" },
      { fetchBlob: async () => { fetched = true; return Buffer.alloc(0); } });
    expect(res.status).toBe(404);
    expect(fetched).toBe(false);
  });
  it("400s on unknown preset", async () => {
    const db = await createTestDb(); await seed(db);
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-photo", preset: "original" as any, accept: "" });
    expect(res.status).toBe(400);
  });
  it("serves an allowlisted blob resized with immutable cache header", async () => {
    const db = await createTestDb(); await seed(db);
    const sharp = (await import("sharp")).default;
    const src = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: "#333" } }).jpeg().toBuffer();
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-photo", preset: "feed", accept: "image/webp" }, { fetchBlob: async () => src });
    expect(res.status).toBe(200);
    expect(res.cacheControl).toBe("public, max-age=31536000, immutable");
    const meta = await sharp(res.body!).metadata();
    expect(meta.width).toBe(1024);
  });
  it("502s with 30s negative cache when the PDS fetch fails", async () => {
    const db = await createTestDb(); await seed(db);
    const res = await proxyImage(db, { did: "did:plc:a", cid: "bafk-photo", preset: "feed", accept: "" }, { fetchBlob: async () => { throw new Error("pds down"); } });
    expect(res.status).toBe(502);
    expect(res.cacheControl).toBe("public, max-age=30");
  });
});
```
Run: `pnpm --filter web test` (add vitest config to web) — Expected: FAIL.

- [ ] **Step 2: Implement** — `lib/image-proxy.ts`:
```ts
import { or, eq, and } from "drizzle-orm";
import sharp from "sharp";
import { photos, photographers, type Db } from "@luminance/db";
import { resolvePdsEndpoint, assertPublicHttps } from "@luminance/atproto";

export const PRESETS = { thumb: 512, feed: 1024, full: 2048 } as const;
export type Preset = keyof typeof PRESETS;

interface Deps { fetchBlob?: (did: string, cid: string) => Promise<Buffer> }

async function defaultFetchBlob(did: string, cid: string): Promise<Buffer> {
  const pds = await resolvePdsEndpoint(did);
  const url = `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
  await assertPublicHttps(url);
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`getBlob ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function proxyImage(db: Db, req: { did: string; cid: string; preset: Preset; accept: string }, deps: Deps = {}) {
  const width = PRESETS[req.preset];
  if (!width) return { status: 400, cacheControl: "public, max-age=3600" };
  // allowlist: only blobs the index references (spec §11)
  const [hit] = await db.select({ cid: photos.blobCid }).from(photos)
    .where(and(eq(photos.blobCid, req.cid), eq(photos.did, req.did))).limit(1);
  const [avatar] = hit ? [hit] : await db.select({ cid: photographers.avatarCid }).from(photographers)
    .where(and(eq(photographers.avatarCid, req.cid), eq(photographers.did, req.did))).limit(1);
  if (!hit && !avatar) return { status: 404, cacheControl: "public, max-age=300" };
  try {
    const buf = await (deps.fetchBlob ?? defaultFetchBlob)(req.did, req.cid);
    const wantsAvif = req.accept.includes("image/avif");
    const wantsWebp = req.accept.includes("image/webp");
    let pipe = sharp(buf).rotate().resize({ width, withoutEnlargement: true });
    pipe = wantsAvif ? pipe.avif({ quality: 70 }) : wantsWebp ? pipe.webp({ quality: 82 }) : pipe.jpeg({ quality: 85 });
    return {
      status: 200, body: await pipe.toBuffer(),
      contentType: wantsAvif ? "image/avif" : wantsWebp ? "image/webp" : "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable",
    };
  } catch {
    return { status: 502, cacheControl: "public, max-age=30" }; // negative cache (spec §12)
  }
}
```
`app/img/[did]/[cid]/[preset]/route.ts`:
```ts
import { getDb } from "@/lib/db";
import { proxyImage, type Preset } from "@/lib/image-proxy";
export async function GET(req: Request, { params }: { params: Promise<{ did: string; cid: string; preset: string }> }) {
  const { did, cid, preset } = await params;
  const r = await proxyImage(getDb(), { did: decodeURIComponent(did), cid, preset: preset as Preset, accept: req.headers.get("accept") ?? "" });
  return new Response(r.body ?? null, { status: r.status, headers: { "Cache-Control": r.cacheControl, ...(r.contentType ? { "Content-Type": r.contentType } : {}) } });
}
```

- [ ] **Step 3: Run** — Expected: PASS (4 tests). **Step 4: Commit** `feat(web): allowlisted image proxy with presets, immutable + negative caching`.

---

### Task 13: OAuth + registration + settings

**Files:**
- Create: `apps/web/lib/oauth.ts`, `apps/web/lib/session.ts`, `apps/web/app/oauth/client-metadata.json/route.ts`, `apps/web/app/oauth/jwks.json/route.ts`, `apps/web/app/oauth/callback/route.ts`, `apps/web/app/register/page.tsx`, `apps/web/app/register/actions.ts`, `apps/web/app/register/sources/page.tsx`, `apps/web/app/register/status/page.tsx`, `apps/web/app/settings/page.tsx`, `apps/web/app/settings/actions.ts`, `apps/web/lib/session.test.ts`, `apps/web/lib/registration.test.ts`
- Modify: `apps/web/package.json` (add `@atproto/oauth-client-node`, `iron-session`)

**Interfaces:**
- Consumes: `oauthStates`/`oauthSessions` tables, `photographers`, `photoOverrides`.
- Produces: `getOAuthClient(db): NodeOAuthClient`; `getSession(): Promise<{ did?: string; isAdmin: boolean }>`; server actions `startLogin(handle: string)`, `saveSources({ includeBsky, includeGrain })` (creates `photographers` row `status:'active'`, `backfillStatus:'pending'`), `setPhotoHidden(atUri, mediaIndex, hidden)`, `deregister()`, `adminTakedown(atUri, reason)`; route `GET /oauth/client-metadata.json` (client_id = `${PUBLIC_URL}/oauth/client-metadata.json`, redirect `${PUBLIC_URL}/oauth/callback`, `dpop_bound_access_tokens: true`, `jwks_uri: ${PUBLIC_URL}/oauth/jwks.json`).

- [ ] **Step 1: Failing tests** — `registration.test.ts` (business logic only; OAuth wire protocol is NOT unit-tested — spec §13 stubs identity):
```ts
import { describe, it, expect } from "vitest";
import { createTestDb, photographers, photoOverrides, photos } from "@luminance/db";
import { eq } from "drizzle-orm";
import { completeRegistration, setHiddenForDid, deregisterDid } from "./registration";

describe("registration logic", () => {
  it("creates an active photographer with pending backfill and chosen toggles", async () => {
    const db = await createTestDb();
    await completeRegistration(db, { did: "did:plc:k", handle: "klee.photos", includeBsky: true, includeGrain: false });
    const [p] = await db.select().from(photographers);
    expect(p).toMatchObject({ status: "active", backfillStatus: "pending", includeGrain: false });
  });
  it("re-registering an existing did updates toggles without duplicating", async () => {
    const db = await createTestDb();
    await completeRegistration(db, { did: "did:plc:k", handle: "klee.photos", includeBsky: true, includeGrain: true });
    await completeRegistration(db, { did: "did:plc:k", handle: "klee.photos", includeBsky: false, includeGrain: true });
    const rows = await db.select().from(photographers);
    expect(rows).toHaveLength(1);
    expect(rows[0].includeBsky).toBe(false);
  });
  it("hide writes an override only for the caller's own photo", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:k", handle: "k.photos" });
    await db.insert(photos).values({ atUri: "at://did:plc:other/c/1", mediaIndex: 0, did: "did:plc:other", source: "bsky", recordCid: "r", blobCid: "b", sortAt: new Date() });
    await expect(setHiddenForDid(db, "did:plc:k", "at://did:plc:other/c/1", 0, true)).rejects.toThrow(/not your photo/);
  });
  it("deregister removes index rows but keeps overrides", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:k", handle: "k.photos" });
    await db.insert(photos).values({ atUri: "at://did:plc:k/c/1", mediaIndex: 0, did: "did:plc:k", source: "luminance", recordCid: "r", blobCid: "b", sortAt: new Date() });
    await db.insert(photoOverrides).values({ atUri: "at://did:plc:k/c/1", mediaIndex: 0, hidden: true });
    await deregisterDid(db, "did:plc:k");
    expect(await db.select().from(photos)).toHaveLength(0);
    expect(await db.select().from(photoOverrides)).toHaveLength(1);
    expect((await db.select().from(photographers))[0].status).toBe("deregistered");
  });
});
```
Run — Expected: FAIL.

- [ ] **Step 2: Implement logic** — `apps/web/lib/registration.ts`:
```ts
import { and, eq } from "drizzle-orm";
import { photographers, photos, photoOverrides, type Db } from "@luminance/db";

export async function completeRegistration(db: Db, o: { did: string; handle: string; includeBsky: boolean; includeGrain: boolean }) {
  await db.insert(photographers)
    .values({ did: o.did, handle: o.handle, includeBsky: o.includeBsky, includeGrain: o.includeGrain, status: "active", backfillStatus: "pending" })
    .onConflictDoUpdate({ target: photographers.did, set: { handle: o.handle, includeBsky: o.includeBsky, includeGrain: o.includeGrain, status: "active", backfillStatus: "pending" } });
}
export async function setHiddenForDid(db: Db, did: string, atUri: string, mediaIndex: number, hidden: boolean) {
  const [row] = await db.select().from(photos).where(and(eq(photos.atUri, atUri), eq(photos.mediaIndex, mediaIndex)));
  if (!row || row.did !== did) throw new Error("not your photo");
  await db.insert(photoOverrides).values({ atUri, mediaIndex, hidden })
    .onConflictDoUpdate({ target: [photoOverrides.atUri, photoOverrides.mediaIndex], set: { hidden, updatedAt: new Date() } });
}
export async function deregisterDid(db: Db, did: string) {
  await db.delete(photos).where(eq(photos.did, did));
  await db.update(photographers).set({ status: "deregistered" }).where(eq(photographers.did, did));
}
export async function adminTakedown(db: Db, atUri: string, mediaIndex: number, reason: string) {
  await db.insert(photoOverrides).values({ atUri, mediaIndex, takedown: true, reason })
    .onConflictDoUpdate({ target: [photoOverrides.atUri, photoOverrides.mediaIndex], set: { takedown: true, reason, updatedAt: new Date() } });
}
```
`lib/oauth.ts` (client + Drizzle-backed stores):
```ts
import { NodeOAuthClient, type NodeSavedState, type NodeSavedSession } from "@atproto/oauth-client-node";
import { JoseKey } from "@atproto/jwk-jose";
import { eq } from "drizzle-orm";
import { oauthStates, oauthSessions, type Db } from "@luminance/db";
import { env } from "./env";

export async function getOAuthClient(db: Db) {
  return new NodeOAuthClient({
    clientMetadata: {
      client_id: `${env.PUBLIC_URL}/oauth/client-metadata.json`,
      client_name: "Luminance",
      client_uri: env.PUBLIC_URL,
      redirect_uris: [`${env.PUBLIC_URL}/oauth/callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "atproto",
      application_type: "web",
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_signing_alg: "ES256",
      dpop_bound_access_tokens: true,
      jwks_uri: `${env.PUBLIC_URL}/oauth/jwks.json`,
    },
    keyset: [await JoseKey.fromImportable(process.env.OAUTH_JWK_1!)],
    stateStore: {
      async set(key, state: NodeSavedState) { await db.insert(oauthStates).values({ key, state }).onConflictDoUpdate({ target: oauthStates.key, set: { state } }); },
      async get(key) { const [r] = await db.select().from(oauthStates).where(eq(oauthStates.key, key)); return r?.state as NodeSavedState | undefined; },
      async del(key) { await db.delete(oauthStates).where(eq(oauthStates.key, key)); },
    },
    sessionStore: {
      async set(key, session: NodeSavedSession) { await db.insert(oauthSessions).values({ key, session }).onConflictDoUpdate({ target: oauthSessions.key, set: { session, updatedAt: new Date() } }); },
      async get(key) { const [r] = await db.select().from(oauthSessions).where(eq(oauthSessions.key, key)); return r?.session as NodeSavedSession | undefined; },
      async del(key) { await db.delete(oauthSessions).where(eq(oauthSessions.key, key)); },
    },
  });
}
```
Add dep `@atproto/jwk-jose`. Generate key: `node -e "const {JoseKey}=await import('@atproto/jwk-jose');const k=await JoseKey.generate(['ES256']);console.log(JSON.stringify(k.privateJwk))"` → `OAUTH_JWK_1`.

`lib/session.ts` (iron-session cookie `{ did }`; `isAdmin = env.ADMIN_DIDS.includes(did)`). `app/oauth/client-metadata.json/route.ts` returns the same object as `clientMetadata`. `app/oauth/jwks.json/route.ts` returns the public JWKS from the keyset. `app/oauth/callback/route.ts`: `client.callback(new URL(req.url).searchParams)` → resolve handle from `session.did` (via `com.atproto.repo.describeRepo` on their PDS or public API) → set iron-session → redirect `/register/sources`. `register/page.tsx`: handle input form → `startLogin` action → `client.authorize(handle)` → redirect. `register/sources/page.tsx`: two checkboxes → `saveSources` action (wraps `completeRegistration` with session DID) → redirect `/register/status`. `register/status/page.tsx`: server component reading `backfillStatus`, meta-refresh every 3s until `complete` → "your photos are live" with link to `/[handle]`. `settings/page.tsx`: toggles + paginated photo grid with hide buttons (each a form posting `setPhotoHidden`) + deregister button (confirm) + admin takedown form when `isAdmin`. All actions check session DID; admin action checks `isAdmin`.

- [ ] **Step 3: Run** — `pnpm --filter web test` — Expected: PASS. Manual smoke (documented, not CI): run `apps/web` with real env against bsky.social — full round-trip login. **Step 4: Commit** `feat(web): atproto oauth, registration flow, settings with curation`.

---

### Task 14: Hub pages — feed, profile, series, photo detail

**Files:**
- Create: `apps/web/app/page.tsx` (replace placeholder), `apps/web/components/photo-grid.tsx`, `apps/web/components/photo-card.tsx`, `apps/web/app/[handle]/page.tsx`, `apps/web/app/[handle]/series/[rkey]/page.tsx`, `apps/web/app/photo/[did]/[collection]/[rkey]/page.tsx`, `apps/web/app/api/feed/route.ts`, `apps/web/app/sitemap.ts`, `apps/web/lib/queries.ts`, `apps/web/lib/queries.test.ts`

**Interfaces:**
- Consumes: `feedPage`, `photos`, `photographers`, `series`, `seriesPhotos`, image proxy URL scheme `/img/{did}/{cid}/{preset}`.
- Produces: `getPhotographerByHandle(db, handle)`, `getPhotoRecord(db, atUri)` (all mediaIndex rows, override-filtered), `getSeries(db, atUri)`; `LABEL_BLUR = ["nudity", "sexual", "porn", "graphic-media"]`.

- [ ] **Step 1: Failing query tests** — `queries.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createTestDb, photos, photographers, photoOverrides } from "@luminance/db";
import { getPhotoRecord, getPhotographerByHandle } from "./queries";

describe("queries", () => {
  it("getPhotoRecord returns all media rows of a multi-image post, minus taken-down ones", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:a", handle: "klee.photos" });
    const uri = "at://did:plc:a/app.bsky.feed.post/1";
    await db.insert(photos).values([0, 1, 2].map((i) => ({ atUri: uri, mediaIndex: i, did: "did:plc:a", source: "bsky" as const, recordCid: "r", blobCid: `b${i}`, sortAt: new Date() })));
    await db.insert(photoOverrides).values({ atUri: uri, mediaIndex: 1, takedown: true });
    const rec = await getPhotoRecord(db, uri);
    expect(rec!.items.map((i) => i.mediaIndex)).toEqual([0, 2]);
  });
  it("getPhotographerByHandle only returns active photographers", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: "did:plc:a", handle: "gone.photos", status: "deregistered" });
    expect(await getPhotographerByHandle(db, "gone.photos")).toBeNull();
  });
});
```
Run — Expected: FAIL.

- [ ] **Step 2: Implement queries** — `lib/queries.ts`:
```ts
import { and, eq, asc, sql } from "drizzle-orm";
import { photos, photographers, series, seriesPhotos, photoOverrides, type Db } from "@luminance/db";

export const LABEL_BLUR = ["nudity", "sexual", "porn", "graphic-media"];

export async function getPhotographerByHandle(db: Db, handle: string) {
  const [p] = await db.select().from(photographers).where(and(eq(photographers.handle, handle), eq(photographers.status, "active")));
  return p ?? null;
}
export async function getPhotoRecord(db: Db, atUri: string) {
  const rows = await db.select({ photo: photos, hidden: photoOverrides.hidden, takedown: photoOverrides.takedown })
    .from(photos)
    .leftJoin(photoOverrides, and(eq(photoOverrides.atUri, photos.atUri), eq(photoOverrides.mediaIndex, photos.mediaIndex)))
    .where(eq(photos.atUri, atUri))
    .orderBy(asc(photos.mediaIndex));
  const items = rows.filter((r) => !r.hidden && !r.takedown).map((r) => r.photo);
  if (!items.length) return null;
  const [ph] = await db.select().from(photographers).where(and(eq(photographers.did, items[0].did), eq(photographers.status, "active")));
  return ph ? { items, photographer: ph } : null;
}
export async function getSeries(db: Db, atUri: string) {
  const [s] = await db.select().from(series).where(eq(series.atUri, atUri));
  if (!s) return null;
  const items = await db.select({ photo: photos })
    .from(seriesPhotos)
    .innerJoin(photos, and(eq(photos.atUri, seriesPhotos.photoUri), eq(photos.mediaIndex, sql`0`)))
    .where(eq(seriesPhotos.seriesUri, atUri))
    .orderBy(asc(seriesPhotos.position));
  return { series: s, items: items.map((i) => i.photo) };
}
```

- [ ] **Step 3: Implement pages.** All server components; images via `<img src={`/img/${p.did}/${p.blobCid}/feed`} alt={p.alt ?? ""} width={p.width ?? undefined} height={p.height ?? undefined} loading="lazy" />` inside an aspect-ratio wrapper (`style={{ aspectRatio: \`${p.width ?? 3}/${p.height ?? 2}\` }}`).
  - `photo-card.tsx`: client component; if `photo.labels` intersects `LABEL_BLUR`, render `blur-2xl` overlay + "Sensitive content — tap to view" button toggling state.
  - `photo-grid.tsx`: CSS columns (`columns-1 sm:columns-2 lg:columns-3 gap-4`) — good-enough justified look for v1; each card links to `/photo/{did}/{collection}/{rkey}`.
  - `app/page.tsx`: `feedPage(getDb(), { limit: 30, cursor: searchParams.cursor })`, grid + "Load more" link `/?cursor=...` (progressive enhancement; infinite scroll can come later — YAGNI).
  - `app/[handle]/page.tsx`: `getPhotographerByHandle` → 404 via `notFound()`; header (avatar via proxy, displayName ?? handle, bio, prominent `website` link) + `feedPage({ did })` grid + series shelf (`select from series where did`). `generateMetadata`: OG title/description + first photo `feed` rendition.
  - `app/photo/[did]/[collection]/[rkey]/page.tsx`: rebuild atUri = `at://{did}/{collection}/{rkey}` (decodeURIComponent on did), `getPhotoRecord` → renders **all** items (per-image `id={`i${mediaIndex}`}` anchors), `full` preset, EXIF panel (definition list: camera, lens, focalLength, fNumber, shutterSpeed, iso — render only present fields), caption, license, tags, source link: `https://bsky.app/profile/{did}/post/{rkey}` when source=bsky, photographer's `website` when luminance. `generateMetadata`: OG image = first item `feed` rendition, `alt` as description.
  - `app/[handle]/series/[rkey]/page.tsx`: `getSeries` by rebuilt at-uri (collection = `social.luminance.portfolio.series` or grain gallery NSID — look up both), ordered grid.
  - `app/sitemap.ts`: all active photographer handles + all photo pages (cap 5,000 most recent).

- [ ] **Step 4: Run** — `pnpm --filter web test && pnpm --filter web build` — Expected: PASS + clean build. **Step 5: Commit** `feat(web): feed, profile, series, photo detail with label gating + OG`.

---

### Task 15: Observability + CI + deploy config

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy-ingestor.yml`, `apps/web/instrumentation.ts`, `apps/ingestor/src/sentry.ts`, `vercel.json`
- Modify: `apps/ingestor/src/main.ts` (Sentry + cursor-lag metric), `apps/web/package.json`, `apps/ingestor/package.json` (Sentry deps)

**Interfaces:**
- Produces: green CI on every push (install → build → typecheck → test → lexicon-drift check); Fly deploy on main; Sentry init in both apps gated on `SENTRY_DSN`.

- [ ] **Step 1: CI** — `.github/workflows/ci.yml`:
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
      - name: lexicon drift check
        run: git diff --exit-code packages/lexicons packages/db/migrations
```
`deploy-ingestor.yml`: on push to main, `superfly/flyctl-actions/setup-flyctl` + `flyctl deploy --config apps/ingestor/fly.toml --dockerfile apps/ingestor/Dockerfile` with `FLY_API_TOKEN` secret. Web deploys via Vercel Git integration (`vercel.json`: `{ "installCommand": "pnpm install", "buildCommand": "pnpm --filter web build" }`; run `drizzle-kit migrate` as a CI step before deploys once `DATABASE_URL` secret exists).

- [ ] **Step 2: Sentry.** `pnpm --filter web add @sentry/nextjs`, `pnpm --filter ingestor add @sentry/node`. Both init only when `process.env.SENTRY_DSN` is set. Ingestor `main.ts` additionally logs a `cursor_lag_seconds` gauge every 60s: `(Date.now()*1000 - Number(cursor.timeUs)) / 1e6`, and `console.error`+Sentry alert if > 300.

- [ ] **Step 3: Verify** — push branch, confirm CI green. **Step 4: Commit** `chore: ci, fly deploy workflow, sentry wiring`.

---

### Task 16: Integration test against a real local PDS + rebuild drill

**Files:**
- Create: `apps/ingestor/src/integration/dev-env.test.ts`, `apps/ingestor/vitest.integration.config.ts`
- Modify: `apps/ingestor/package.json` (script `test:integration`, devDep `@atproto/dev-env`, `@atproto/api`)

**Interfaces:**
- Consumes: everything. This is the spec §13 integration gate and success-criterion 3 (rebuild drill).

- [ ] **Step 1: Write the test** — `dev-env.test.ts` (long-running; excluded from default `test` script, run via `pnpm --filter ingestor test:integration`):
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TestNetworkNoAppView } from "@atproto/dev-env";
import { AtpAgent } from "@atproto/api";
import { createTestDb, photographers, photos } from "@luminance/db";
import { Indexer } from "../indexer.js";
import { runBackfill } from "../backfill.js";
import { LUMINANCE_PHOTO } from "@luminance/lexicons";

let network: TestNetworkNoAppView; let agent: AtpAgent; let did: string;

beforeAll(async () => {
  network = await TestNetworkNoAppView.create({ dbPostgresSchema: "luminance_it" });
  agent = network.pds.getClient();
  await agent.createAccount({ handle: "kevin.test", email: "k@test.com", password: "pw" });
  did = agent.session!.did;
}, 60_000);
afterAll(async () => { await network?.close(); });

async function writePhoto(rkey: string) {
  const img = Buffer.from("/9j/4AAQSkZJRgABAQAAAQ==", "base64"); // 1px jpeg
  const up = await agent.uploadBlob(img, { encoding: "image/jpeg" });
  await agent.com.atproto.repo.putRecord({
    repo: did, collection: LUMINANCE_PHOTO, rkey,
    record: { $type: LUMINANCE_PHOTO, image: up.data.blob, createdAt: new Date().toISOString() },
  });
}

describe("foundation end-to-end (dev-env)", () => {
  it("backfills real records from a real PDS, honors deletes, and passes the rebuild drill", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did, handle: "kevin.test" });
    const indexer = new Indexer(db);
    await writePhoto("p1"); await writePhoto("p2");
    const fetchJson = async (url: string) => {
      // dev-env PDS is http://localhost — bypass the https guard for the test-local fetcher only
      const res = await fetch(url); if (!res.ok) throw new Error(String(res.status)); return res.json();
    };
    const resolvePds = async () => network.pds.url;
    await runBackfill(db, indexer, did, { fetchJson, resolvePds });
    expect(await db.select().from(photos)).toHaveLength(2);

    // live delete
    await agent.com.atproto.repo.deleteRecord({ repo: did, collection: LUMINANCE_PHOTO, rkey: "p1" });
    await indexer.handleEvent({ did, time_us: Date.now() * 1000, kind: "commit", commit: { operation: "delete", collection: LUMINANCE_PHOTO, rkey: "p1" } });
    expect(await db.select().from(photos)).toHaveLength(1);

    // rebuild drill (success criterion 3): truncate index, re-backfill, converge
    await db.delete(photos);
    await db.update(photographers).set({ backfillStatus: "pending" });
    await runBackfill(db, indexer, did, { fetchJson, resolvePds });
    const rows = await db.select().from(photos);
    expect(rows).toHaveLength(1);
    expect(rows[0].atUri).toContain("/p2");
  }, 120_000);
});
```

- [ ] **Step 2: Run** — `pnpm --filter ingestor test:integration` — Expected: PASS (requires Docker for dev-env Postgres; document in README). **Step 3: Commit** `test(ingestor): dev-env integration + rebuild drill`.

---

### Task 17: Lexicon publishing + launch checklist (manual runbook)

**Files:**
- Create: `docs/runbooks/publish-lexicons.md`, `docs/runbooks/launch-alpha.md`

- [ ] **Step 1:** `publish-lexicons.md` documents: (1) DNS TXT `_lexicon.luminance.social` → the authority DID; (2) publishing each lexicon JSON as a `com.atproto.lexicon.schema` record (rkey = NSID) in the authority account's repo, with the exact `putRecord` invocations; (3) verification via `resolveLexicon`.
- [ ] **Step 2:** `launch-alpha.md` checklist: Neon prod DB + migrations; Vercel project + all env vars from `.env.example`; Fly app + secrets; DNS for luminance.social; OAuth smoke test with a real bsky.social account; register Kevin's account; verify a Bluesky post appears in feed < 60s (success criterion 2); Lighthouse run on `/` and one photo page (criterion 4).
- [ ] **Step 3: Commit** `docs: lexicon publishing + alpha launch runbooks`.

---

## Self-Review (completed)

1. **Spec coverage:** §6 architecture → T1/8/9/11/15; §7 lexicon + sources → T3/5/6/7; §8 data model → T2; §9 ingestion (tombstones, clamp, caps, toggles, identity/account, stale cursor) → T5/8/9/10; §10 surface (routes, proxy, OAuth, registration knob, settings, OG/sitemap, dotless invariant) → T11–14; §11 security + regression tests → T4/12; §12 error handling/observability/backup (Neon PITR is a provider setting — noted in launch runbook) → T8/9/12/15; §13 testing → every task + T16; §15 criteria → T16 (rebuild drill) + T17 (60s + Lighthouse checks). Gap check: spec's "filter chips for disciplines/tags" on the feed — deliberately deferred to keep T14 shippable; tags are indexed, chips are a follow-up. Noted here so it's a conscious cut, not an omission.
2. **Placeholder scan:** no TBDs; Task 7 Step 1 is an explicit verify-then-adjust instruction (spec-mandated), not a placeholder.
3. **Type consistency:** `MappedPhoto`/`Ctx` defined in T5, consumed in T6/7/8/10; `feedPage`/`createTestDb` defined in T2, consumed in T8/10/12/13/14/16; `proxyImage` deps injection consistent between T12 test and impl; `completeRegistration`/`setHiddenForDid`/`deregisterDid` names match between T13 test and impl.
