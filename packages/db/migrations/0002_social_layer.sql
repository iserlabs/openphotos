CREATE TYPE "public"."interaction_kind" AS ENUM('like', 'comment', 'follow');--> statement-breakpoint
CREATE TABLE "engagement" (
	"post_uri" text PRIMARY KEY NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"repost_count" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"record_uri" text PRIMARY KEY NOT NULL,
	"actor_did" text NOT NULL,
	"kind" "interaction_kind" NOT NULL,
	"subject_uri" text NOT NULL,
	"text" text,
	"record_cid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"recipient_did" text NOT NULL,
	"actor_did" text NOT NULL,
	"actor_handle" text NOT NULL,
	"actor_avatar_url" text,
	"kind" "interaction_kind" NOT NULL,
	"subject_uri" text NOT NULL,
	"link_uri" text NOT NULL,
	"snippet" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "interactions_lookup_idx" ON "interactions" USING btree ("actor_did","kind","subject_uri");--> statement-breakpoint
CREATE INDEX "interactions_subject_idx" ON "interactions" USING btree ("subject_uri");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_idx" ON "notifications" USING btree ("kind","subject_uri","actor_did","recipient_did");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_did","created_at" DESC NULLS LAST);