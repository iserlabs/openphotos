import { safeJsonFetch } from "./safe-fetch.js";

// ---- Structural types ----------------------------------------------------
// These declare only the fields Luminance actually reads off Bluesky's public
// AppView responses — not the full app.bsky.* lexicon shapes. Where the real
// lexicon uses a union (e.g. threadViewPost's `replies` also permits
// notFoundPost/blockedPost), we collapse to the shape we care about since we
// only ever read `.post`/`.replies` off nodes we visit.

export interface AppViewAuthor {
  did: string;
  handle: string;
  avatar?: string;
}

export interface AppViewPostRecord {
  text: string;
}

export interface PostView {
  uri: string;
  cid: string;
  author: AppViewAuthor;
  record: AppViewPostRecord;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  indexedAt: string;
}

export interface ThreadView {
  post: PostView;
  replies: ThreadView[];
}

export interface ActorView {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  createdAt?: string;
}

export interface LikeView {
  actor: ActorView;
  createdAt: string;
  indexedAt: string;
}

export interface ProfileView {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  description?: string;
  followersCount: number;
}

type FetchJson = (url: string) => Promise<unknown>;

const GET_POSTS_CHUNK_SIZE = 25;

/**
 * Thin, unauthenticated client for Bluesky's public AppView
 * (https://public.api.bsky.app). No retries here — callers own retry/backoff
 * policy (e.g. the engagement sweep).
 */
export class AppView {
  private readonly base: string;
  private readonly fetchJson: FetchJson;

  constructor(base: string = "https://public.api.bsky.app", fetchJson: FetchJson = safeJsonFetch) {
    this.base = base;
    this.fetchJson = fetchJson;
  }

  /** Batches into groups of 25 (XRPC's per-request `uris` cap) and fetches sequentially. */
  async getPosts(uris: string[]): Promise<PostView[]> {
    const out: PostView[] = [];
    for (let i = 0; i < uris.length; i += GET_POSTS_CHUNK_SIZE) {
      const chunk = uris.slice(i, i + GET_POSTS_CHUNK_SIZE);
      const u = new URL(`${this.base}/xrpc/app.bsky.feed.getPosts`);
      for (const uri of chunk) u.searchParams.append("uris", uri);
      const res = (await this.fetchJson(u.toString())) as { posts: PostView[] };
      out.push(...res.posts);
    }
    return out;
  }

  async getPostThread(uri: string, depth = 10): Promise<ThreadView> {
    const u = new URL(`${this.base}/xrpc/app.bsky.feed.getPostThread`);
    u.searchParams.set("uri", uri);
    u.searchParams.set("depth", String(depth));
    const res = (await this.fetchJson(u.toString())) as { thread: ThreadView };
    return res.thread;
  }

  async getLikes(uri: string, limit = 100): Promise<LikeView[]> {
    const u = new URL(`${this.base}/xrpc/app.bsky.feed.getLikes`);
    u.searchParams.set("uri", uri);
    u.searchParams.set("limit", String(limit));
    const res = (await this.fetchJson(u.toString())) as { likes: LikeView[] };
    return res.likes;
  }

  async getFollowers(did: string, limit = 100): Promise<ActorView[]> {
    const u = new URL(`${this.base}/xrpc/app.bsky.graph.getFollowers`);
    u.searchParams.set("actor", did);
    u.searchParams.set("limit", String(limit));
    const res = (await this.fetchJson(u.toString())) as { followers: ActorView[] };
    return res.followers;
  }

  async getProfile(did: string): Promise<ProfileView> {
    const u = new URL(`${this.base}/xrpc/app.bsky.actor.getProfile`);
    u.searchParams.set("actor", did);
    return (await this.fetchJson(u.toString())) as ProfileView;
  }
}
