"use client";

import { useState } from "react";

/**
 * Text-content counterpart to {@link SensitiveImage} (`photo-card.tsx`):
 * blurs its children behind a click-through reveal overlay when `sensitive`
 * is true, until the viewer taps through. Used by `comment-thread.tsx` to
 * blur-gate labeled reply text (spec §7 — comment threads inherit Bluesky's
 * moderation labels the same way photos do).
 */
export function SensitiveText({
  sensitive,
  children,
}: {
  sensitive: boolean;
  children: React.ReactNode;
}) {
  const [revealed, setRevealed] = useState(false);
  if (!sensitive || revealed) return <>{children}</>;
  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none select-none blur-sm">
        {children}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setRevealed(true);
        }}
        className="absolute inset-0 flex items-center justify-center bg-black/50 px-2 text-center text-xs font-medium text-zinc-100 transition-colors hover:bg-black/60"
      >
        Sensitive content — tap to view
      </button>
    </div>
  );
}
