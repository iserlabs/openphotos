export const COMMENT_MAX_GRAPHEMES = 300; // app.bsky.feed.post text cap (spec §4)

const seg = new Intl.Segmenter();

export function graphemeLength(s: string): number {
  let n = 0;
  for (const _ of seg.segment(s)) n++;
  return n;
}

type Ref = { uri: string; cid: string };

export function buildLikeRecord(subject: Ref, now = new Date()) {
  return { $type: "app.bsky.feed.like" as const, subject, createdAt: now.toISOString() };
}

export function buildReplyRecord(text: string, root: Ref, parent: Ref, now = new Date()) {
  const len = graphemeLength(text.trim());
  if (len < 1 || len > COMMENT_MAX_GRAPHEMES) throw new Error(`comment must be 1–${COMMENT_MAX_GRAPHEMES} graphemes`);
  return { $type: "app.bsky.feed.post" as const, text, reply: { root, parent }, createdAt: now.toISOString() };
}

export function buildFollowRecord(subjectDid: string, now = new Date()) {
  return { $type: "app.bsky.graph.follow" as const, subject: subjectDid, createdAt: now.toISOString() };
}
