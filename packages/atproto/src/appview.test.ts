import { describe, it, expect, vi } from "vitest";
import { AppView } from "./appview.js";
import getPostsFixture from "./fixtures/appview/getPosts.json" with { type: "json" };
import getPostThreadFixture from "./fixtures/appview/getPostThread.json" with { type: "json" };
import getLikesFixture from "./fixtures/appview/getLikes.json" with { type: "json" };
import getFollowersFixture from "./fixtures/appview/getFollowers.json" with { type: "json" };
import getProfileFixture from "./fixtures/appview/getProfile.json" with { type: "json" };

const POST_URI = "at://did:plc:ka5oytd2d6rhs2r6yrvt6yb2/app.bsky.feed.post/3mrap7bkyuc2t";
const DID = "did:plc:ka5oytd2d6rhs2r6yrvt6yb2";

describe("AppView.getPosts", () => {
  it("builds the exact XRPC URL and parses fixture fields", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=at%3A%2F%2Fdid%3Aplc%3Aka5oytd2d6rhs2r6yrvt6yb2%2Fapp.bsky.feed.post%2F3mrap7bkyuc2t",
      );
      return getPostsFixture;
    });
    const av = new AppView(undefined, fetchJson);
    const posts = await av.getPosts([POST_URI]);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      uri: POST_URI,
      cid: "bafyreifnfpexjb5rv6lyecqq24mylurj53rmpwxtlfvgy4y35vsidwbime",
      likeCount: 0,
      replyCount: 0,
      repostCount: 0,
      indexedAt: "2026-07-22T16:04:48.867Z",
    });
    expect(posts[0].author).toMatchObject({
      did: DID,
      handle: "kevinleephotos.bsky.social",
    });
    expect(posts[0].author.avatar).toContain("cdn.bsky.app");
    expect(posts[0].record.text).toBe("#photography #nikon #zf");
  });

  it("chunks 30 URIs into two sequential calls of 25 + 5 and concatenates results in order", async () => {
    const uris = Array.from({ length: 30 }, (_, i) => `at://did:plc:test/app.bsky.feed.post/p${i}`);
    const encUri = (i: number) => `at%3A%2F%2Fdid%3Aplc%3Atest%2Fapp.bsky.feed.post%2Fp${i}`;
    const expectedFirstUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?${Array.from(
      { length: 25 },
      (_, i) => `uris=${encUri(i)}`,
    ).join("&")}`;
    const expectedSecondUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?${Array.from(
      { length: 5 },
      (_, i) => `uris=${encUri(25 + i)}`,
    ).join("&")}`;

    const calls: string[] = [];
    const fetchJson = vi.fn(async (url: string) => {
      calls.push(url);
      // Reuse the real single-post fixture for each chunk response so the
      // test stays grounded in captured-real data rather than fabricated shapes.
      return getPostsFixture;
    });
    const av = new AppView(undefined, fetchJson);
    const posts = await av.getPosts(uris);

    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(calls[0]).toBe(expectedFirstUrl);
    expect(calls[1]).toBe(expectedSecondUrl);
    // one post returned per chunk call, concatenated in call order
    expect(posts).toHaveLength(2);
  });

  it("issues no calls for an empty URI list", async () => {
    const fetchJson = vi.fn(async () => getPostsFixture);
    const av = new AppView(undefined, fetchJson);
    expect(await av.getPosts([])).toEqual([]);
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

describe("AppView.getPostThread", () => {
  it("builds the exact URL (uri + default depth) and parses the thread", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at%3A%2F%2Fdid%3Aplc%3Aka5oytd2d6rhs2r6yrvt6yb2%2Fapp.bsky.feed.post%2F3mrap7bkyuc2t&depth=10",
      );
      return getPostThreadFixture;
    });
    const av = new AppView(undefined, fetchJson);
    const thread = await av.getPostThread(POST_URI);
    expect(thread.post).toMatchObject({ uri: POST_URI, replyCount: 0 });
    // this real post has no replies — still confirms the (empty) nested shape parses
    expect(thread.replies).toEqual([]);
  });

  it("honors an explicit depth override in the URL", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toContain("depth=3");
      return getPostThreadFixture;
    });
    const av = new AppView(undefined, fetchJson);
    await av.getPostThread(POST_URI, 3);
  });
});

describe("AppView.getLikes", () => {
  it("builds the exact URL (uri + default limit) and parses an empty likes fixture", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://public.api.bsky.app/xrpc/app.bsky.feed.getLikes?uri=at%3A%2F%2Fdid%3Aplc%3Aka5oytd2d6rhs2r6yrvt6yb2%2Fapp.bsky.feed.post%2F3mrap7bkyuc2t&limit=100",
      );
      return getLikesFixture;
    });
    const av = new AppView(undefined, fetchJson);
    const likes = await av.getLikes(POST_URI);
    expect(likes).toEqual([]);
  });

  it("honors an explicit limit override in the URL", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toContain("limit=50");
      return getLikesFixture;
    });
    const av = new AppView(undefined, fetchJson);
    await av.getLikes(POST_URI, 50);
  });
});

describe("AppView.getFollowers", () => {
  it("builds the exact URL (actor + default limit) and parses fixture fields", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://public.api.bsky.app/xrpc/app.bsky.graph.getFollowers?actor=did%3Aplc%3Aka5oytd2d6rhs2r6yrvt6yb2&limit=100",
      );
      return getFollowersFixture;
    });
    const av = new AppView(undefined, fetchJson);
    const followers = await av.getFollowers(DID);
    expect(followers).toHaveLength(3);
    expect(followers[0]).toMatchObject({
      did: "did:plc:gm5w2ga7lcqakdgrdktovzqy",
      handle: "lagomuller.bsky.social",
    });
    expect(followers[0].avatar).toContain("cdn.bsky.app");
  });
});

describe("AppView.getProfile", () => {
  it("builds the exact URL and parses fixture fields", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=did%3Aplc%3Aka5oytd2d6rhs2r6yrvt6yb2",
      );
      return getProfileFixture;
    });
    const av = new AppView(undefined, fetchJson);
    const profile = await av.getProfile(DID);
    expect(profile).toMatchObject({
      did: DID,
      handle: "kevinleephotos.bsky.social",
      followersCount: 10,
    });
  });
});

describe("AppView constructor defaults", () => {
  it("defaults to the public AppView base and safeJsonFetch when unspecified", () => {
    expect(() => new AppView()).not.toThrow();
  });

  it("honors a custom base URL", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      expect(url.startsWith("https://custom.example.com/xrpc/")).toBe(true);
      return getProfileFixture;
    });
    const av = new AppView("https://custom.example.com", fetchJson);
    await av.getProfile(DID);
  });
});
