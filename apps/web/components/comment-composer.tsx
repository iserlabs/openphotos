"use client";

import { useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { commentAction } from "@/app/photo/actions";
import { SESSION_EXPIRED_ERROR, loginHref } from "@/lib/interaction-errors";

// Mirrors COMMENT_MAX_GRAPHEMES in packages/atproto/src/interaction-records.ts
// (the actual server-enforced cap, keyed off app.bsky.feed.post's own text
// limit) — kept as a local literal rather than an import so this file stays
// a small, dependency-free client bundle.
const MAX_GRAPHEMES = 300;

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter() : undefined;

/** Live grapheme count for the composer's "N/300" counter — Unicode-aware
 * (emoji, combining marks, etc. each count once), matching what the server
 * actually validates against. */
function graphemeCount(text: string): number {
  if (!segmenter) return [...text].length; // very old runtime fallback
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/**
 * Comment/reply composer for the photo page. `parentUri`/`parentCid` are
 * optional — when provided, this composes a reply to that specific comment
 * instead of a top-level comment on the photo (both go through the same
 * `commentAction`, which defaults `parent` to the photo's own post when
 * omitted).
 */
export function CommentComposer({
  atUri,
  parentUri,
  parentCid,
  placeholder = "Add a comment…",
}: {
  atUri: string;
  parentUri?: string;
  parentCid?: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Count graphemes on the trimmed text, matching the server's own
  // trim-then-validate order (packages/atproto/src/interaction-records.ts) —
  // otherwise leading/trailing whitespace could push the client-side counter
  // and block over a limit the server wouldn't actually enforce.
  const count = useMemo(() => graphemeCount(text.trim()), [text]);
  const overLimit = count > MAX_GRAPHEMES;
  const empty = text.trim().length === 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (empty || overLimit || isPending) return;

    setError(null);
    const formData = new FormData();
    formData.set("atUri", atUri);
    formData.set("text", text);
    if (parentUri) formData.set("parentUri", parentUri);
    if (parentCid) formData.set("parentCid", parentCid);

    startTransition(async () => {
      const result = await commentAction(formData);
      if (!result.ok) {
        if (result.error === SESSION_EXPIRED_ERROR) {
          router.push(loginHref(pathname));
          return;
        }
        setError(result.error);
        return;
      }
      setText("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={3}
        disabled={isPending}
        aria-label="Comment"
        className="w-full resize-none rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-60"
      />
      <div className="flex items-center justify-between gap-3">
        <span className={`text-xs ${overLimit ? "text-red-400" : "text-zinc-600"}`}>
          {count}/{MAX_GRAPHEMES}
        </span>
        <button
          type="submit"
          disabled={empty || overLimit || isPending}
          className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
        >
          {isPending ? "Posting…" : "Comment"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      ) : null}
    </form>
  );
}
