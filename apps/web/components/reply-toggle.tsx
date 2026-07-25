"use client";

import { useState } from "react";
import { CommentComposer } from "./comment-composer";

/**
 * Per-comment "Reply" affordance: toggles an inline {@link CommentComposer}
 * targeting this comment as the reply parent. The composer posts through the
 * same `commentAction` path as top-level comments — the server validates that
 * the supplied parent actually belongs to this photo's thread before creating
 * the record (see `commentOnPhoto`'s parent-ref validation).
 */
export function ReplyToggle({
  atUri,
  parentUri,
  parentCid,
  parentHandle,
}: {
  /** The photo's at-uri (the thread root's subject). */
  atUri: string;
  parentUri: string;
  parentCid: string;
  parentHandle: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-zinc-600 hover:text-zinc-300"
      >
        {open ? "Cancel" : "Reply"}
      </button>
      {open ? (
        <CommentComposer
          atUri={atUri}
          parentUri={parentUri}
          parentCid={parentCid}
          placeholder={`Reply to @${parentHandle}…`}
        />
      ) : null}
    </div>
  );
}
