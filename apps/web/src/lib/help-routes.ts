import { NAV_GROUPS } from "./nav";

/**
 * Which screen a URL counts as, for the purpose of help.
 *
 * `/clients/8f21.../payments` is the Clients screen. An article must not have
 * to be pinned to every client id in the database, and a person stuck on a
 * client's payments tab is stuck on Clients.
 *
 * The longest matching nav href wins, so `/ads/reports` resolves to Ad reports
 * rather than to Ads — the same rule the sidebar already uses to decide what to
 * highlight, so the help panel and the highlighted nav item always agree.
 */

/** Every screen a person can be standing on, longest first so matching is greedy. */
export const HELP_ROUTES: readonly string[] = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));

const BY_LENGTH = [...HELP_ROUTES].sort((a, b) => b.length - a.length);

export function helpRouteFor(pathname: string): string {
  const path = pathname.split("?")[0]!.replace(/\/+$/, "") || "/";
  const match = BY_LENGTH.find((href) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`)));
  return match ?? path;
}

/** The nav label for a route, for the coverage table and the help panel's heading. */
export function helpRouteLabel(route: string): string {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) if (item.href === route) return item.label;
  }
  return route;
}
