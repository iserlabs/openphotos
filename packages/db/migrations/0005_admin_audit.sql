CREATE TABLE "admin_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_did" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
