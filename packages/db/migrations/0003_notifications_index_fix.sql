DROP INDEX "notifications_recipient_idx";--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_did","id" DESC NULLS LAST);