import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TestNetworkNoAppView } from "@atproto/dev-env";
import type { AtpAgent } from "@atproto/api";
import {
  createTestDb,
  photographers,
  photos,
  interactions,
  notifications,
  engagementFor,
  findInteraction,
  type Db,
} from "@luminance/db";
import {
  likePhoto,
  unlikePhoto,
  commentOnPhoto,
  deleteOwnComment,
  followPhotographer,
  unfollowPhotographer,
  type AgentFactory,
} from "../lib/interactions";

// ── Social-layer write-path integration (spec §11 criteria 1–3) ───────────────
// The phase-1 dev-env test (apps/ingestor/src/integration/dev-env.test.ts)
// proved the READ path end-to-end (real PDS -> real backfill -> index). This is
// its phase-2 sibling for the WRITE path: two real accounts on a real local PDS,
// a photographer who posts a real image post, and a viewer who likes / comments /
// follows through the REAL interaction service (likePhoto/commentOnPhoto/…) with
// their own password-session agent as the `agentFactory`. Every assertion checks
// BOTH sides of the write: the record really landed in the viewer's repo
// (com.atproto.repo.listRecords) AND the write-through row/notification/engagement
// delta the service is responsible for.
//
// Excluded from the default `pnpm test` (see vitest.config.ts `exclude`); run
// explicitly with `pnpm --filter web test:integration`.
//
// Notes (same installed-reality caveats the phase-1 test documents):
//  1. dev-env 0.5.36's TestNetworkNoAppView is SQLite-native in a temp dir — no
//     Docker/Postgres. `create()` takes no args here.
//  2. `network.pds.getAgent()` returns a fresh authenticated AtpAgent each call,
//     so we get one per account. AtpAgent extends Agent, so it drops straight
//     into the service's `AgentFactory` seam with no adapter.
//  3. The index half (photographers + photos rows) is built directly rather than
//     via runBackfill — the backfill machinery is already integration-tested in
//     phase 1, and this test is about the write path, not re-proving indexing.

let network: TestNetworkNoAppView;
let photographerAgent: AtpAgent;
let viewerAgent: AtpAgent;
let photographerDid: string;
let viewerDid: string;

const PHOTOGRAPHER_HANDLE = "photographer.test";
const VIEWER_HANDLE = "viewer.test";

// Minimal but valid 1x1 JPEG — uploadBlob only needs real bytes + a mime hint.
const ONE_PX_JPEG =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==";

beforeAll(async () => {
  network = await TestNetworkNoAppView.create();
  // dev-env serviceHandleDomains include ".test" — handles must end in one.
  photographerAgent = network.pds.getAgent();
  await photographerAgent.createAccount({
    handle: PHOTOGRAPHER_HANDLE,
    email: "photographer@test.com",
    password: "password",
  });
  photographerDid = photographerAgent.session!.did;

  viewerAgent = network.pds.getAgent();
  await viewerAgent.createAccount({
    handle: VIEWER_HANDLE,
    email: "viewer@test.com",
    password: "password",
  });
  viewerDid = viewerAgent.session!.did;
}, 120_000);

afterAll(async () => {
  await network?.close();
});

/** Every record the viewer holds in `collection`, freshest fetch each call. */
async function viewerRecords(collection: string) {
  const res = await viewerAgent.com.atproto.repo.listRecords({ repo: viewerDid, collection });
  return res.data.records as { uri: string; cid: string; value: Record<string, unknown> }[];
}

describe("social write path end-to-end (dev-env)", () => {
  it("round-trips like, comment, unlike, delete-comment, follow, unfollow against a real PDS", async () => {
    // ── Photographer posts a real image post ─────────────────────────────────
    const img = Buffer.from(ONE_PX_JPEG, "base64");
    const up = await photographerAgent.uploadBlob(img, { encoding: "image/jpeg" });
    const post = await photographerAgent.com.atproto.repo.createRecord({
      repo: photographerDid,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text: "sunrise over the ridge",
        embed: {
          $type: "app.bsky.embed.images",
          images: [{ image: up.data.blob, alt: "a test photo" }],
        },
        createdAt: new Date().toISOString(),
      },
    });
    const postUri = post.data.uri;
    const postCid = post.data.cid;
    const blobCid = up.data.blob.ref.toString();

    // ── Seed OUR index directly (photographer + a photos row for the post) ────
    const db: Db = await createTestDb();
    await db.insert(photographers).values({ did: photographerDid, handle: PHOTOGRAPHER_HANDLE });
    await db.insert(photos).values({
      atUri: postUri,
      mediaIndex: 0,
      did: photographerDid,
      source: "bsky",
      recordCid: postCid,
      blobCid,
      sortAt: new Date(),
    });

    // The viewer's own password-session agent IS the production agent seam.
    const agentFactory: AgentFactory = async () => viewerAgent;
    const photoLinkUri = `/photo/${encodeURIComponent(photographerDid)}/app.bsky.feed.post/${postUri.split("/").pop()}`;

    // ── LIKE ─────────────────────────────────────────────────────────────────
    const likeResult = await likePhoto(db, agentFactory, viewerDid, {
      uri: postUri,
      cid: postCid,
      photographerDid,
      photoLinkUri,
      actorHandle: VIEWER_HANDLE,
    });
    expect(likeResult).toEqual({ ok: true });

    // …record really exists in the viewer's repo…
    const likeRec = (await viewerRecords("app.bsky.feed.like")).find(
      (r) => (r.value.subject as { uri?: string } | undefined)?.uri === postUri,
    );
    expect(likeRec).toBeDefined();

    // …write-through interaction row…
    const likeRow = await findInteraction(db, viewerDid, "like", postUri);
    expect(likeRow).not.toBeNull();
    expect(likeRow!.recordUri).toBe(likeRec!.uri);

    // …notification for the photographer…
    const likeNotifs = await db.select().from(notifications);
    expect(likeNotifs).toHaveLength(1);
    expect(likeNotifs[0]).toMatchObject({
      recipientDid: photographerDid,
      actorDid: viewerDid,
      kind: "like",
      subjectUri: postUri,
      linkUri: photoLinkUri,
    });

    // …and the pending +1 like delta (no engagement cache row yet).
    expect((await engagementFor(db, [postUri])).get(postUri)?.likeCount).toBe(1);

    // ── COMMENT ──────────────────────────────────────────────────────────────
    const commentText = "gorgeous light on those peaks";
    const commentResult = await commentOnPhoto(db, agentFactory, viewerDid, VIEWER_HANDLE, {
      subject: { uri: postUri, cid: postCid },
      text: commentText,
      photographerDid,
      photoLinkUri,
    });
    expect(commentResult).toEqual({ ok: true });

    // …reply record in the viewer's repo, root & parent == the photo's post…
    const replyRec = (await viewerRecords("app.bsky.feed.post")).find((r) => {
      const reply = r.value.reply as { root?: { uri?: string }; parent?: { uri?: string } } | undefined;
      return reply?.root?.uri === postUri && reply?.parent?.uri === postUri;
    });
    expect(replyRec).toBeDefined();
    expect(replyRec!.value.text).toBe(commentText);

    // …a comment interaction row keyed by that reply's uri…
    const commentRow = await findInteraction(db, viewerDid, "comment", postUri);
    expect(commentRow).not.toBeNull();
    expect(commentRow!.recordUri).toBe(replyRec!.uri);

    // …a notification carrying the snippet…
    const commentNotif = (await db.select().from(notifications)).find((n) => n.kind === "comment");
    expect(commentNotif).toBeDefined();
    expect(commentNotif!.snippet).toBe(commentText);

    // …and the pending +1 reply delta.
    expect((await engagementFor(db, [postUri])).get(postUri)?.replyCount).toBe(1);

    // ── UNLIKE (round-trip) ──────────────────────────────────────────────────
    expect(await unlikePhoto(db, agentFactory, viewerDid, postUri)).toEqual({ ok: true });
    // …record gone from the repo…
    expect(
      (await viewerRecords("app.bsky.feed.like")).find(
        (r) => (r.value.subject as { uri?: string } | undefined)?.uri === postUri,
      ),
    ).toBeUndefined();
    // …local row soft-deleted (findInteraction filters deletedAt IS NULL)…
    expect(await findInteraction(db, viewerDid, "like", postUri)).toBeNull();
    const softLike = (await db.select().from(interactions)).find((r) => r.recordUri === likeRec!.uri);
    expect(softLike!.deletedAt).not.toBeNull();
    // …and the delta returns to 0.
    expect((await engagementFor(db, [postUri])).get(postUri)?.likeCount).toBe(0);

    // ── DELETE OWN COMMENT (round-trip) ──────────────────────────────────────
    expect(await deleteOwnComment(db, agentFactory, viewerDid, replyRec!.uri)).toEqual({ ok: true });
    expect(
      (await viewerRecords("app.bsky.feed.post")).find((r) => r.uri === replyRec!.uri),
    ).toBeUndefined();
    expect(await findInteraction(db, viewerDid, "comment", postUri)).toBeNull();
    const softComment = (await db.select().from(interactions)).find((r) => r.recordUri === replyRec!.uri);
    expect(softComment!.deletedAt).not.toBeNull();
    expect((await engagementFor(db, [postUri])).get(postUri)?.replyCount).toBe(0);

    // ── FOLLOW ───────────────────────────────────────────────────────────────
    expect(
      await followPhotographer(db, agentFactory, viewerDid, VIEWER_HANDLE, { photographerDid }),
    ).toEqual({ ok: true });
    const followRec = (await viewerRecords("app.bsky.graph.follow")).find(
      (r) => r.value.subject === photographerDid,
    );
    expect(followRec).toBeDefined();
    // The follow notification's linkUri is built from the DB handle, never client input (spec §4).
    const followNotif = (await db.select().from(notifications)).find((n) => n.kind === "follow");
    expect(followNotif).toBeDefined();
    expect(followNotif!.linkUri).toBe(`/${PHOTOGRAPHER_HANDLE}`);

    // ── UNFOLLOW (round-trip) ────────────────────────────────────────────────
    expect(await unfollowPhotographer(db, agentFactory, viewerDid, photographerDid)).toEqual({ ok: true });
    expect(
      (await viewerRecords("app.bsky.graph.follow")).find((r) => r.value.subject === photographerDid),
    ).toBeUndefined();
    expect(await findInteraction(db, viewerDid, "follow", photographerDid)).toBeNull();
    const softFollow = (await db.select().from(interactions)).find((r) => r.recordUri === followRec!.uri);
    expect(softFollow!.deletedAt).not.toBeNull();
  }, 120_000);
});
