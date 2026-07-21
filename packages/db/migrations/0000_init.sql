CREATE TYPE "public"."backfill_status" AS ENUM('pending', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."photo_source" AS ENUM('luminance', 'bsky', 'grain');--> statement-breakpoint
CREATE TYPE "public"."photographer_status" AS ENUM('active', 'pending_review', 'deactivated', 'deregistered', 'takedown');--> statement-breakpoint
CREATE TABLE "ingest_cursors" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"time_us" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_sessions" (
	"key" text PRIMARY KEY NOT NULL,
	"session" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"key" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photo_overrides" (
	"at_uri" text NOT NULL,
	"media_index" integer NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"takedown" boolean DEFAULT false NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photo_overrides_at_uri_media_index_pk" PRIMARY KEY("at_uri","media_index")
);
--> statement-breakpoint
CREATE TABLE "photographers" (
	"did" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"avatar_cid" text,
	"bio" text,
	"website" text,
	"location" text,
	"status" "photographer_status" DEFAULT 'active' NOT NULL,
	"include_bsky" boolean DEFAULT true NOT NULL,
	"include_grain" boolean DEFAULT true NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backfill_status" "backfill_status" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"at_uri" text NOT NULL,
	"media_index" integer NOT NULL,
	"did" text NOT NULL,
	"source" "photo_source" NOT NULL,
	"record_cid" text NOT NULL,
	"blob_cid" text NOT NULL,
	"width" integer,
	"height" integer,
	"alt" text,
	"title" text,
	"caption" text,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"sort_at" timestamp with time zone NOT NULL,
	"exif" jsonb,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"license" text,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"group_key" text,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photos_at_uri_media_index_pk" PRIMARY KEY("at_uri","media_index")
);
--> statement-breakpoint
CREATE TABLE "series" (
	"at_uri" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"cover_photo_uri" text,
	"created_at" timestamp with time zone,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series_photos" (
	"series_uri" text NOT NULL,
	"photo_uri" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "series_photos_series_uri_photo_uri_pk" PRIMARY KEY("series_uri","photo_uri")
);
--> statement-breakpoint
CREATE TABLE "tombstones" (
	"at_uri" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "photos_feed_idx" ON "photos" USING btree ("sort_at" DESC NULLS LAST,"at_uri" DESC NULLS LAST,"media_index" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "photos_did_idx" ON "photos" USING btree ("did","sort_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "photos_blob_idx" ON "photos" USING btree ("blob_cid");