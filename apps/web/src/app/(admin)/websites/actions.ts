"use server";

import { captureSiteScreenshot, getSite } from "@launchos/core";
import { createIntegrations } from "@launchos/integrations";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export type ActionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * Photograph one site now.
 *
 * The deliberate half of the thumbnail story. The scheduled job only fills in
 * sites that have never been captured; this is what you press after a redesign
 * goes live, or before writing a case study, when you actually want today's
 * picture rather than the one taken when the site was added.
 *
 * Synchronous rather than queued, unusually for this app. A capture takes a
 * few seconds and the person pressing the button is looking at the thing they
 * expect to change — handing it to the worker would mean a button that appears
 * to do nothing and a picture that updates whenever. The button carries its own
 * pending state instead.
 *
 * `getSite` is what scopes this to the session's organisation: an id belonging
 * to another tenant comes back null and is refused here, before any URL is
 * fetched on anybody's behalf.
 */
export async function refreshSiteScreenshotAction(siteId: string): Promise<ActionResult> {
  const session = await requireAdmin();
  const db = getDb();

  const site = await getSite(db, session.organisationId, siteId);
  if (!site) return { status: "error", message: "That website is not on your account." };

  const result = await captureSiteScreenshot(
    db,
    session.organisationId,
    { siteId: site.id, url: site.primaryUrl },
    createIntegrations(process.env).screenshots,
  );

  // Both outcomes revalidate: a failure writes its reason to the row, and the
  // list is where that reason is shown.
  revalidatePath("/websites");
  revalidatePath(`/websites/${site.id}`);

  if (!result.ok) return { status: "error", message: result.reason ?? "The capture failed." };
  return { status: "ok" };
}
