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
 */
export function MotionRoot() {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stops = [revealOnScroll(reduced), countUp(reduced), parallax(reduced)];
    return () => stops.forEach((stop) => stop());
  }, []);
  return null;
}

const STAGGER_MS = 60;
const COUNT_MS = 1200;

function revealOnScroll(reduced: boolean): () => void {
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
  if (reduced || !("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("is-in"));
    return () => undefined;
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
  targets.forEach((el) => observer.observe(el));
  return () => observer.disconnect();
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

function countUp(reduced: boolean): () => void {
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-count]"));
  if (targets.length === 0) return () => undefined;
  const render = (el: HTMLElement, value: number) => {
    const pad = Number(el.dataset.pad ?? 0);
    el.textContent = String(Math.round(value)).padStart(pad, "0");
  };
  if (reduced || !("IntersectionObserver" in window)) {
    targets.forEach((el) => render(el, Number(el.dataset.count)));
    return () => undefined;
  }
  const frames = new Set<number>();
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
  targets.forEach((el) => {
    render(el, 0);
    observer.observe(el);
  });
  return () => {
    observer.disconnect();
    frames.forEach((id) => cancelAnimationFrame(id));
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
