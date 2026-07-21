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
