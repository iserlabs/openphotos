"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type LightboxItem = { src: string; alt: string };

const LightboxContext = createContext<((index: number) => void) | null>(null);

/**
 * Fullscreen photo lightbox (spec §10) with keyboard navigation: Escape
 * closes, ArrowLeft/ArrowRight move between a multi-image post's photos.
 * Wrap the photo list in the provider and each clickable image in a
 * {@link LightboxTrigger}; everything renders inline (no portal needed — the
 * overlay is `fixed inset-0` above the page).
 */
export function LightboxProvider({ items, children }: { items: LightboxItem[]; children: React.ReactNode }) {
  const [index, setIndex] = useState<number | null>(null);

  const close = useCallback(() => setIndex(null), []);
  const step = useCallback(
    (delta: number) => {
      setIndex((cur) => {
        if (cur === null) return cur;
        return (cur + delta + items.length) % items.length;
      });
    },
    [items.length],
  );

  useEffect(() => {
    if (index === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    }
    window.addEventListener("keydown", onKey);
    // Lock page scroll while the overlay is up.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [index, close, step]);

  const current = index !== null ? items[index] : null;

  return (
    <LightboxContext.Provider value={setIndex}>
      {children}
      {current ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Photo viewer"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/95"
          onClick={close}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current.src}
            alt={current.alt}
            className="max-h-[92vh] max-w-[94vw] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            autoFocus
            className="absolute right-4 top-4 rounded-full bg-black/60 px-3 py-1.5 text-lg text-zinc-200 hover:bg-black/80"
          >
            ×
          </button>
          {items.length > 1 ? (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  step(-1);
                }}
                aria-label="Previous photo"
                className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-black/60 px-3 py-2 text-lg text-zinc-200 hover:bg-black/80"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  step(1);
                }}
                aria-label="Next photo"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-black/60 px-3 py-2 text-lg text-zinc-200 hover:bg-black/80"
              >
                ›
              </button>
              <span className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-zinc-400">
                {index! + 1} / {items.length}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
    </LightboxContext.Provider>
  );
}

/** Wraps an image in a click target that opens the lightbox at `index`. */
export function LightboxTrigger({ index, children }: { index: number; children: React.ReactNode }) {
  const open = useContext(LightboxContext);
  if (!open) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={() => open(index)}
      aria-label="View full size"
      className="block w-full cursor-zoom-in text-left"
    >
      {children}
    </button>
  );
}
