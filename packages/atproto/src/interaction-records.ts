export const COMMENT_MAX_GRAPHEMES = 300; // app.bsky.feed.post text cap (spec §4)

const seg = new Intl.Segmenter();

export function graphemeLength(s: string): number {
  let n = 0;
  for (const _ of seg.segment(s)) n++;
  return n;
}

/**
 * Slice the first `n` grapheme clusters of `s`, e.g. for a notification
 * snippet. Unlike `s.slice(0, n)` — which counts UTF-16 code units and can
 * split a surrogate pair or a multi-code-point emoji sequence (ZWJ, flags,
 * skin-tone modifiers) right down the middle, leaving a lone surrogate behind
 * — this always cuts on a grapheme boundary, so the result is always valid.
 */
export function graphemeSlice(s: string, n: number): string {
  let out = "";
  let count = 0;
  for (const { segment } of seg.segment(s)) {
    if (count >= n) break;
    out += segment;
    count++;
  }
  return out;
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
