"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { deleteCommentAction } from "@/app/photo/actions";
import { SESSION_EXPIRED_ERROR, loginHref } from "@/lib/interaction-errors";

/**
 * Delete affordance for the viewer's own comment, with pending and error
 * feedback (the previous plain `<form action>` discarded the action result,
 * so a failed delete left the comment in place with no signal). An expired
 * OAuth session routes to re-auth instead of showing a dead error.
 */
export function DeleteCommentButton({ recordUri }: { recordUri: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onDelete() {
    if (isPending) return;
    setError(null);
    const formData = new FormData();
    formData.set("recordUri", recordUri);
    startTransition(async () => {
      const result = await deleteCommentAction(formData);
      if (!result.ok) {
        if (result.error === SESSION_EXPIRED_ERROR) {
          router.push(loginHref(pathname));
          return;
        }
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={onDelete}
        disabled={isPending}
        className="text-xs text-zinc-600 hover:text-red-400 disabled:opacity-60"
      >
        {isPending ? "Deleting…" : "Delete"}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-red-400">
          {error}
        </span>
      ) : null}
    </span>
  );
}
