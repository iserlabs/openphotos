"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * Blurs its children (`blur-2xl`) behind a click-through overlay when
 * `sensitive` is true, until the viewer taps through. Used directly by the
 * photo-detail page (full-size images, not nested in an interactive
 * ancestor). Grid tiles in {@link PhotoCard} implement an equivalent reveal
 * step inline instead of reusing this component, because their reveal
 * button must NOT be nested inside the tile's `<Link>` (no interactive
 * element may nest inside another). The sensitivity intersection against
 * `LABEL_BLUR` is computed by callers (server components) and passed down
 * as a plain boolean — this file stays free of any `@luminance/db`/drizzle
 * imports.
 */
export function SensitiveImage({
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
      <div aria-hidden className="pointer-events-none blur-2xl">
        {children}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setRevealed(true);
        }}
        className="absolute inset-0 flex items-center justify-center bg-black/50 px-4 text-center text-sm font-medium text-zinc-100 transition-colors hover:bg-black/60"
      >
        Sensitive content — tap to view
      </button>
    </div>
  );
}

export function PhotoCard({
  href,
  src,
  alt,
  width,
  height,
  sensitive,
  priority = false,
  likeCount,
  replyCount,
  srcSet,
  sizes,
}: {
  href: string;
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
  sensitive: boolean;
  /** Above-the-fold LCP candidates: eager-load with a high fetch priority. */
  priority?: boolean;
  /**
   * Engagement counts (spec §3): same number on every tile of a multi-image
   * post — by design, since counts are per-post, not per-media-index. Only
   * rendered when the caller actually supplies them (bsky-source posts with
   * a resolved `engagementFor` entry); omitted entirely for anything else.
   */
  likeCount?: number;
  replyCount?: number;
  /** Responsive renditions — browsers pick the smallest sufficient file. */
  srcSet?: string;
  sizes?: string;
}) {
  const [revealed, setRevealed] = useState(false);

  const image = (
    <div style={{ aspectRatio: `${width ?? 3}/${height ?? 2}` }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        srcSet={srcSet}
        sizes={sizes}
        alt={alt}
        width={width ?? undefined}
        height={height ?? undefined}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : undefined}
        className="h-full w-full object-cover"
      />
    </div>
  );

  const hasCounts = likeCount !== undefined || replyCount !== undefined;
  const counts = hasCounts ? (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-5">
      <span className="text-xs text-zinc-400">
        {likeCount !== undefined ? (
          <span aria-label={`${likeCount} like${likeCount === 1 ? "" : "s"}`}>♥ {likeCount}</span>
        ) : null}
        {likeCount !== undefined && replyCount !== undefined ? " · " : null}
        {replyCount !== undefined ? (
          <span aria-label={`${replyCount} ${replyCount === 1 ? "comment" : "comments"}`}>💬 {replyCount}</span>
        ) : null}
      </span>
    </div>
  ) : null;

  // Sensitive + unrevealed: the tile IS the reveal button, not a Link —
  // nesting a <button> inside a <Link> would put two interactive elements
  // one inside the other. Once revealed, swap in the normal Link-wrapped
  // tile below.
  if (sensitive && !revealed) {
    return (
      <div className="relative mb-4 block break-inside-avoid overflow-hidden rounded-md bg-zinc-900">
        <div aria-hidden className="pointer-events-none blur-2xl">
          {image}
        </div>
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="absolute inset-0 flex items-center justify-center bg-black/50 px-4 text-center text-sm font-medium text-zinc-100 transition-colors hover:bg-black/60"
        >
          Sensitive content — tap to view
        </button>
      </div>
    );
  }

  return (
    <Link href={href} className="relative mb-4 block break-inside-avoid overflow-hidden rounded-md bg-zinc-900">
      {image}
      {counts}
    </Link>
  );
}
