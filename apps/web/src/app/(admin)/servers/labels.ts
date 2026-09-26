/**
 * Plain data shared between the server page and the client actions menu.
 *
 * No `"use client"`/`"use server"` directive on purpose: `page.tsx` is a
 * server component and reads `BUSY_LABEL[...]` directly. A directive-bearing
 * module's exports arrive at a server component as client-reference proxies,
 * and indexing into one throws at request time ("Cannot access … on the
 * server") even though it typechecks and builds cleanly — this module has to
 * stay free of any directive so both sides can import the same plain object.
 */
export const BUSY_LABEL: Record<string, string> = {
  reboot: "Rebooting…",
  shutdown: "Shutting down…",
  poweron: "Powering on…",
  create_image: "Taking snapshot…",
  enable_backup: "Turning on backups…",
  disable_backup: "Turning off backups…",
};
