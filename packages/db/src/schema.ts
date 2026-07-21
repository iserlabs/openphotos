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
