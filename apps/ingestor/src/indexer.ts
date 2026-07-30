import { eq, inArray, or, sql } from "drizzle-orm";
import { photos, series, seriesPhotos, photographers, tombstones, type Db } from "@openphotos/db";
import {
  mapLuminanceProfile, mapBskyPost, mapBskyProfile,
  mapGrainRecord, GRAIN_COLLECTIONS, mapOpencontentPhotograph, mapOpencontentCollection,
  type Ctx, type MappedPhoto, type MappedSeries,
} from "@openphotos/atproto";
import {
  LUMINANCE_PROFILE, BSKY_POST, BSKY_PROFILE,
  OPENCONTENT_PHOTOGRAPH, OPENCONTENT_COLLECTION,
} from "@openphotos/lexicons";

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
      // Account events are the PDS account lifecycle only — they move a
      // photographer among {active, deactivated, takedown} and MUST NOT touch
      // app-managed states: 'pending_review' (moderation hold) and
      // 'deregistered' (opt-out) are never resurrected by an active:true event
      // (nor pushed into 'deactivated', which would become a resurrection vector
      // via a later active:true).
      const LIFECYCLE = ["active", "deactivated", "takedown"] as const;
      if (!(LIFECYCLE as readonly string[]).includes(ph.status)) return;
      const status: (typeof LIFECYCLE)[number] =
        evt.account?.active ? "active" : (evt.account?.status === "takendown" ? "takedown" : "deactivated");
      await this.db.update(photographers).set({ status }).where(eq(photographers.did, evt.did));
      return;
    }
    if (evt.kind !== "commit" || !evt.commit) return;
    const c = evt.commit;
    const uri = `at://${evt.did}/${c.collection}/${c.rkey}`;

    if (c.operation === "delete") {
      await this.db.transaction(async (tx) => {
        await tx.delete(photos).where(eq(photos.atUri, uri));
        await tx.delete(series).where(eq(series.atUri, uri));
        await tx.delete(seriesPhotos).where(or(
          eq(seriesPhotos.seriesUri, uri), eq(seriesPhotos.photoUri, uri), eq(seriesPhotos.itemUri, uri),
        ));
        if (ph.backfillStatus === "running") {
          await tx.insert(tombstones).values({ atUri: uri }).onConflictDoNothing(); // spec §9 race guard
        }
      });
      this.stats.deleted++;
      return;
    }

    const ctx: Ctx = { did: evt.did, collection: c.collection, rkey: c.rkey, cid: c.cid ?? "", indexedAt: new Date() };
    try {
      if (c.collection === LUMINANCE_PROFILE) {
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
          bio: sql`coalesce(${photographers.bio}, ${p.bio})`,
        }).where(eq(photographers.did, evt.did));
      } else if (GRAIN_COLLECTIONS.includes(c.collection)) {
        if (!ph.includeGrain) return;
        const m = mapGrainRecord(ctx, c.record);
        if (!m) return void this.stats.skipped++;
        if (m.photo) await this.applyPhotoRows([m.photo]);
        if (m.series) await this.applySeries(m.series);
        if (m.seriesItem) await this.db.insert(seriesPhotos).values({
          seriesUri: m.seriesItem.seriesUri, photoUri: m.seriesItem.photoUri,
          position: m.seriesItem.position, itemUri: m.seriesItem.itemUri,
        }).onConflictDoUpdate({
          target: [seriesPhotos.seriesUri, seriesPhotos.photoUri],
          set: { position: m.seriesItem.position, itemUri: m.seriesItem.itemUri },
        });
      } else if (c.collection === OPENCONTENT_PHOTOGRAPH) {
        // no includeOpencontent toggle: the portfolio vocabulary is the point,
        // not an optional supplementary source (spec §6)
        const m = mapOpencontentPhotograph(ctx, c.record);
        if (!m) return void this.stats.skipped++;
        await this.applyPhotoRows([m]);
      } else if (c.collection === OPENCONTENT_COLLECTION) {
        const m = mapOpencontentCollection(ctx, c.record);
        if (!m) return void this.stats.skipped++;
        await this.applySeries(m);
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
        exif: sql`excluded.exif`, tags: sql`excluded.tags`, labels: sql`excluded.labels`,
        width: sql`excluded.width`, height: sql`excluded.height`, capturedAt: sql`excluded.captured_at`,
        license: sql`excluded.license` },
    });
    this.stats.indexed += rows.length;
  }

  private async applySeries(m: MappedSeries) {
    await this.db.insert(series).values({ atUri: m.atUri, did: m.did, title: m.title, description: m.description, coverPhotoUri: m.coverPhotoUri, createdAt: m.createdAt })
      .onConflictDoUpdate({ target: series.atUri, set: { title: sql`excluded.title`, description: sql`excluded.description`, coverPhotoUri: sql`excluded.cover_photo_uri` } });
    if (m.itemsAuthoritative) {
      await this.db.transaction(async (tx) => {
        await tx.delete(seriesPhotos).where(eq(seriesPhotos.seriesUri, m.atUri));
        if (m.items.length) {
          await tx.insert(seriesPhotos).values(m.items.map((i) => ({ seriesUri: m.atUri, photoUri: i.photoUri, position: i.position })));
        }
      });
    }
  }
}
