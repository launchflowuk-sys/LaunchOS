"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A row of tabs too wide for the screen, that says so.
 *
 * The row already scrolled — `overflow-x-auto` — but the scrollbar is hidden,
 * which on a desktop leaves no affordance whatsoever: the thirteenth tab is
 * sliced down the middle of its first letter and reads as broken text rather
 * than as "there is more this way". A client with thirteen tabs had a Reports
 * page nobody could reach from the Profit page.
 *
 * Two things fix it, and neither adds a control to look at:
 *
 * - **A fade at whichever edge has more behind it.** A word cut off under a
 *   gradient is obviously continuing; a word cut off at a hard border is
 *   obviously a bug. The fades appear only when there is actually something
 *   out of view, so a narrow tab row on a wide screen is untouched.
 * - **The active tab is scrolled into view on arrival.** Landing on Reports
 *   with Reports off-screen is the same failure from the other direction.
 *
 * `scrollend` where the browser has it, with a plain `scroll` listener as the
 * fallback, because Safari only gained `scrollend` recently and the fade being
 * a frame late is worse than it being computed a few extra times.
 */
export function TabScroller({ children, className }: { children: ReactNode; className?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });

  const measure = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    // A pixel of slack: sub-pixel layout leaves scrollLeft a fraction short of
    // the true maximum, which would otherwise show a fade for ever at the end.
    const max = node.scrollWidth - node.clientWidth;
    setEdges({ start: node.scrollLeft > 1, end: node.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;

    // Bring the current tab into view before measuring, so the fades describe
    // where the row actually ends up rather than where it started.
    const current = node.querySelector<HTMLElement>('[aria-current="page"]');
    if (current) {
      const left = current.offsetLeft;
      const right = left + current.offsetWidth;
      if (left < node.scrollLeft || right > node.scrollLeft + node.clientWidth) {
        // `center` rather than `nearest`: a tab flush against the fade is
        // legible but still looks clipped.
        current.scrollIntoView({ inline: "center", block: "nearest" });
      }
    }

    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);

  return (
    <div className="relative">
      <div ref={scroller} className={cn("scrollbar-none flex overflow-x-auto", className)}>
        {children}
      </div>
      {/* Decorative and never clickable — a fade that swallowed a tab's click
          would be a worse bug than the one it fixes. */}
      <div
        aria-hidden
        data-visible={edges.start ? "true" : "false"}
        className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent opacity-0 transition-opacity data-[visible=true]:opacity-100"
      />
      <div
        aria-hidden
        data-visible={edges.end ? "true" : "false"}
        className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent opacity-0 transition-opacity data-[visible=true]:opacity-100"
      />
    </div>
  );
}
