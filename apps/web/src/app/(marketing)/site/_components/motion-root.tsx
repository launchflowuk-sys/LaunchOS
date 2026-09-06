"use client";

import { useEffect } from "react";

/**
 * The public site's motion runtime: about a kilobyte that does three jobs
 * for the CSS in `motion.css`.
 *
 * 1. Scroll reveals — every `[data-reveal]` gets `.is-in` the first time it
 *    enters the viewport, staggered 60ms behind the siblings before it.
 * 2. Counters — `[data-count]` counts from zero to its number when seen.
 * 3. Parallax — on a desktop pointer, `[data-parallax]` receives `--px` /
 *    `--py` in [-1, 1] from the mouse; the layers inside move by depth.
 *
 * Mounted from `template.tsx`, so it runs once per navigation against the
 * page that has just rendered. Under `prefers-reduced-motion: reduce` it
 * shows everything at rest and does nothing else.
 *
 * **It also watches for content that arrives after it.** The scan alone was a
 * bug: the pages are async server components that read the database, so on a
 * client-side navigation React commits this template while the page is still
 * suspended. The scan then found nothing, nothing was ever observed, and every
 * `[data-reveal]` on the new page stayed at `opacity: 0` for good — a Work
 * page with a header and nothing under it, until you navigated somewhere else.
 * A `MutationObserver` picks up whatever mounts later, which is the only
 * arrangement that survives streaming.
 */
export function MotionRoot() {
  useEffect(() => {
    // Tells the stylesheet the runtime arrived, which turns off its safety
    // reveal. Never removed: once a page has a working runtime it has one for
    // the rest of the visit, and a gap between two templates must not let the
    // safety animation start.
    document.documentElement.classList.add("motion-on");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const reveal = revealOnScroll(reduced);
    const count = countUp(reduced);
    const stops = [reveal.stop, count.stop, parallax(reduced)];

    // Streamed content, and anything a client component renders later.
    const watcher = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.hasAttribute("data-reveal")) reveal.add(node);
          if (node.hasAttribute("data-count")) count.add(node);
          node.querySelectorAll<HTMLElement>("[data-reveal]").forEach(reveal.add);
          node.querySelectorAll<HTMLElement>("[data-count]").forEach(count.add);
        }
      }
    });
    watcher.observe(document.body, { childList: true, subtree: true });

    return () => {
      watcher.disconnect();
      stops.forEach((stop) => stop());
    };
  }, []);
  return null;
}

const STAGGER_MS = 60;
const COUNT_MS = 1200;

/** A live watcher: `add` takes one more element, `stop` tears the whole thing down. */
interface Watched {
  add: (el: HTMLElement) => void;
  stop: () => void;
}

function revealOnScroll(reduced: boolean): Watched {
  if (reduced || !("IntersectionObserver" in window)) {
    const show = (el: HTMLElement) => el.classList.add("is-in");
    document.querySelectorAll<HTMLElement>("[data-reveal]").forEach(show);
    return { add: show, stop: () => undefined };
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        el.style.transitionDelay = `${siblingIndex(el) * STAGGER_MS}ms`;
        el.classList.add("is-in");
        observer.unobserve(el);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
  );
  // Already revealed means already seen: re-observing on a navigation back
  // would replay the stagger on content the visitor has read.
  const add = (el: HTMLElement) => {
    if (!el.classList.contains("is-in")) observer.observe(el);
  };
  document.querySelectorAll<HTMLElement>("[data-reveal]").forEach(add);
  return { add, stop: () => observer.disconnect() };
}

function siblingIndex(el: HTMLElement): number {
  const parent = el.parentElement;
  if (!parent) return 0;
  let index = 0;
  for (const child of Array.from(parent.children)) {
    if (child === el) return index;
    if (child.hasAttribute("data-reveal") && !child.classList.contains("is-in")) index += 1;
  }
  return 0;
}

function countUp(reduced: boolean): Watched {
  const render = (el: HTMLElement, value: number) => {
    const pad = Number(el.dataset.pad ?? 0);
    el.textContent = String(Math.round(value)).padStart(pad, "0");
  };
  if (reduced || !("IntersectionObserver" in window)) {
    const show = (el: HTMLElement) => render(el, Number(el.dataset.count));
    document.querySelectorAll<HTMLElement>("[data-count]").forEach(show);
    return { add: show, stop: () => undefined };
  }
  const frames = new Set<number>();
  const counted = new WeakSet<HTMLElement>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        observer.unobserve(el);
        const target = Number(el.dataset.count);
        const start = performance.now();
        const step = (now: number) => {
          const t = Math.min(1, (now - start) / COUNT_MS);
          render(el, target * (1 - Math.pow(1 - t, 3)));
          if (t < 1) frames.add(requestAnimationFrame(step));
        };
        frames.add(requestAnimationFrame(step));
      }
    },
    { threshold: 0.5 },
  );
  // Zeroing a figure that has already counted would make a navigation back
  // reset the number under the visitor's eyes.
  const add = (el: HTMLElement) => {
    if (counted.has(el)) return;
    counted.add(el);
    render(el, 0);
    observer.observe(el);
  };
  document.querySelectorAll<HTMLElement>("[data-count]").forEach(add);
  return {
    add,
    stop: () => {
      observer.disconnect();
      frames.forEach((id) => cancelAnimationFrame(id));
    },
  };
}

function parallax(reduced: boolean): () => void {
  const container = document.querySelector<HTMLElement>("[data-parallax]");
  if (!container || reduced || !window.matchMedia("(pointer: fine)").matches) return () => undefined;
  const onMove = (event: MouseEvent) => {
    const x = (event.clientX / window.innerWidth - 0.5) * 2;
    const y = (event.clientY / window.innerHeight - 0.5) * 2;
    container.style.setProperty("--px", x.toFixed(3));
    container.style.setProperty("--py", y.toFixed(3));
  };
  window.addEventListener("mousemove", onMove, { passive: true });
  return () => window.removeEventListener("mousemove", onMove);
}
