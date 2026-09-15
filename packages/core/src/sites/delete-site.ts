import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

/**
 * Removing a website record that should not be there.
 *
 * There was no way to do this, which is how a client ends up with the same
 * site listed twice and no means of fixing it — the exact situation on Gateway
 * Taxis, two rows for `gatewaytaxis.co.uk` added four days apart. Every other
 * record in LaunchOS could be archived or deleted; a site could only be added.
 *
 * Built the same way `deleteClient` is, for the same reasons:
 *
 * **It refuses rather than cascades.** A site with a monitor, a domain, an
 * incident or a support case attached is load-bearing, and quietly deleting
 * those alongside it would destroy history nobody asked to lose. The report
 * names what is in the way so the person can move it and try again — that is
 * a thirty-second job, whereas an unnoticed cascade is unrecoverable.
 *
 * **The audit row is written before the delete**, because once the row is gone
 * there is nothing left to reference, and the record of what was destroyed has
 * to outlive the thing.
 *
 * Screenshots and stored credentials are the exception: they cascade, because
 * a picture of a site and a password *for* that site have no meaning without
 * it and nobody would go looking for either afterwards.
 */

export interface SiteDeletionBlocker {
  kind: "monitor" | "domain" | "incident" | "ticket";
  count: number;
  detail: string;
}

export interface SiteDeletionReport {
  siteId: string;
  siteName: string;
  primaryUrl: string;
  deletable: boolean;
  blockers: SiteDeletionBlocker[];
  /** What goes with it when it is deleted. Said out loud so it is never a surprise. */
  cascades: string[];
}

/** One count per dependent table, written out rather than generalised: five
 * tables with five different column types is exactly where a clever helper
 * needs more casts than the plain version needs lines. */
async function counts(db: Db, siteId: string) {
  const one = async (rows: Promise<{ n: number }[]>) => Number((await rows)[0]?.n ?? 0);
  const [monitors, domains, incidents, tickets, screenshots, credentials] = await Promise.all([
    one(db.select({ n: count() }).from(schema.monitors).where(eq(schema.monitors.siteId, siteId))),
    one(db.select({ n: count() }).from(schema.domains).where(eq(schema.domains.siteId, siteId))),
    one(db.select({ n: count() }).from(schema.incidents).where(eq(schema.incidents.siteId, siteId))),
    one(db.select({ n: count() }).from(schema.tickets).where(eq(schema.tickets.siteId, siteId))),
    one(db.select({ n: count() }).from(schema.siteScreenshots).where(eq(schema.siteScreenshots.siteId, siteId))),
    one(db.select({ n: count() }).from(schema.siteCredentials).where(eq(schema.siteCredentials.siteId, siteId))),
  ]);
  return { monitors, domains, incidents, tickets, screenshots, credentials };
}

/** What stands in the way of deleting this site, and what would go with it. */
export async function siteDeletionReport(db: Db, organisationId: string, siteId: string): Promise<SiteDeletionReport> {
  const [site] = await db
    .select({ id: schema.sites.id, name: schema.sites.name, primaryUrl: schema.sites.primaryUrl })
    .from(schema.sites)
    .where(and(eq(schema.sites.id, siteId), eq(schema.sites.organisationId, organisationId), isNull(schema.sites.deletedAt)));
  if (!site) throw new Error(`site ${siteId} not found in organisation`);

  const { monitors, domains, incidents, tickets, screenshots, credentials } = await counts(db, siteId);

  const blockers: SiteDeletionBlocker[] = [];
  if (monitors > 0) blockers.push({ kind: "monitor", count: monitors, detail: `${monitors} monitor${monitors === 1 ? "" : "s"} watch it — delete the monitor first` });
  if (domains > 0) blockers.push({ kind: "domain", count: domains, detail: `${domains} domain${domains === 1 ? " points" : "s point"} at it — point it elsewhere or clear the site on the domain first` });
  if (incidents > 0) blockers.push({ kind: "incident", count: incidents, detail: `${incidents} incident${incidents === 1 ? "" : "s"} recorded against it — that history would be orphaned` });
  if (tickets > 0) blockers.push({ kind: "ticket", count: tickets, detail: `${tickets} support case${tickets === 1 ? "" : "s"} reference it` });

  const cascades: string[] = [];
  if (screenshots > 0) cascades.push(`${screenshots} screenshot${screenshots === 1 ? "" : "s"}`);
  if (credentials > 0) cascades.push(`${credentials} stored credential${credentials === 1 ? "" : "s"}`);

  return {
    siteId: site.id,
    siteName: site.name,
    primaryUrl: site.primaryUrl,
    deletable: blockers.length === 0,
    blockers,
    cascades,
  };
}

export const DeleteSiteInput = z.object({
  siteId: z.string().uuid(),
  /**
   * The site's address, typed out.
   *
   * The URL rather than the name, because the case this exists for is two rows
   * with the *same* name — "Gateway Taxis" twice — where typing the name would
   * confirm nothing about which one is going. The address is what a person
   * reads off the row they mean.
   */
  confirmUrl: z.string().trim().min(1),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type DeleteSiteInput = z.input<typeof DeleteSiteInput>;

/** Deletes a site for good. Refuses unless the report says it can go. */
export async function deleteSite(db: Db, organisationId: string, input: DeleteSiteInput): Promise<void> {
  const v = DeleteSiteInput.parse(input);
  const report = await siteDeletionReport(db, organisationId, v.siteId);

  const typed = v.confirmUrl.replace(/\/+$/, "").toLowerCase();
  const actual = report.primaryUrl.replace(/\/+$/, "").toLowerCase();
  if (typed !== actual) {
    throw new Error(`Type ${report.primaryUrl} exactly to delete this site`);
  }
  if (!report.deletable) {
    throw new Error(`${report.primaryUrl} cannot be deleted: ${report.blockers.map((b) => b.detail).join("; ")}.`);
  }

  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [before] = await tx
      .select()
      .from(schema.sites)
      .where(and(eq(schema.sites.id, v.siteId), eq(schema.sites.organisationId, organisationId)));
    if (!before) throw new Error(`site ${v.siteId} not found in organisation`);

    // Before the delete: afterwards there is no row to point the audit at.
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind,
      actorId: v.actorId,
      action: "site.deleted",
      targetType: "site",
      targetId: v.siteId,
      before: { ...before, deletionReport: report },
    });

    await tx.delete(schema.sites).where(and(eq(schema.sites.id, v.siteId), eq(schema.sites.organisationId, organisationId)));
  });
}
