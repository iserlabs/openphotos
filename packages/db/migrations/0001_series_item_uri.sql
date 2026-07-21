ALTER TABLE "series_photos" ADD COLUMN "item_uri" text;--> statement-breakpoint
CREATE INDEX "series_photos_item_idx" ON "series_photos" USING btree ("item_uri");