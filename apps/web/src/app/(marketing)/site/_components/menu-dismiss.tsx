"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Shuts the mobile menu when you use it.
 *
 * The menu is a native `<details>` on purpose — it opens and closes with no
 * script at all, which is what a marketing page should do the instant its
 * HTML arrives. But `open` is DOM state, and the header lives in the layout,
 * which React keeps across a client-side navigation. So tapping a link
 * navigated the page underneath and left the menu sitting over it: you had to
 * close it by hand to read what you had just asked for.
 *
 * Two ways to close it, because they cover different journeys:
 *
 * 1. **On the tap.** The menu shuts as your finger leaves the link, rather
 *    than a moment later when the next page commits — and it also covers
 *    tapping the link for the page you are already on, which changes no
 *    pathname and would otherwise leave the menu open for ever.
 * 2. **On the pathname changing.** Back, forward, and any navigation that did
 *    not begin with a tap inside the menu.
 *
 * The listener is on the document, capturing, so it sees the click before
 * anything can stop it propagating, and it never calls `preventDefault` — the
 * link still navigates exactly as it did.
 */
export function MenuDismiss() {
  const pathname = usePathname();

  useEffect(() => {
    for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.site-menu[open]")) {
      menu.open = false;
    }
  }, [pathname]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest("a[href]");
      if (!link) return;
      const menu = link.closest<HTMLDetailsElement>("details.site-menu");
      if (menu) menu.open = false;
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return null;
}
