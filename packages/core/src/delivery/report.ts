import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { CaseStudyScreenshots, PackageIncludes, ProjectPhaseStatus } from "@launchos/db/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { listAccessLocations, type AccessLocation } from "../access/access-entries.js";
import { getProject } from "../projects/get-project.js";
import { describeProgress, type ProjectProgress } from "../projects/progress.js";
import type { ProjectRow } from "../projects/shared.js";
import { DeliveryRefused, getDeliverySignOff, type DeliverySignOffRow } from "./shared.js";

/**
 * The delivery report, compiled from the project rather than typed by hand.
 *
 * Everything in it is already recorded somewhere: the phases and milestones
 * are the plan the client has been watching, the sites are the sites, the
 * monitors are what is actually being checked, the care plan is the package
 * they are on. Nobody writes this document — which is the point. A handover
 * note somebody types on a Friday afternoon is a handover note that says
 * whatever they remembered.
 *
 * **The one thing it will not carry is a credential.** The vault holds the
 * client's passwords; this report names the doors and says where the keys are
 * kept. The data for that section comes from `listAccessLocations`, whose
 * query does not select a secret, a username or the notes field — see the
 * comment there. Nothing in this file has a plaintext password to print even
 * if it wanted one.
 */

export const BuildDeliveryReportInput = z.object({ projectId: z.string().uuid() });
export type BuildDeliveryReportInput = z.input<typeof BuildDeliveryReportInput>;

/** One step of the build, as the client is shown it. */
export interface DeliveryReportPhase {
  name: string;
  status: ProjectPhaseStatus;
  doneAt: Date | null;
}

/** One promise kept. Internal milestones are left out before this is built. */
export interface DeliveryReportMilestone {
  title: string;
  detail: string | null;
  reachedAt: Date | null;
}

export interface DeliveryReportSite {
  name: string;
  url: string;
  live: boolean;
}

/** What is being watched, and how often. Never the credentials to watch it. */
export interface DeliveryReportMonitor {
  siteName: string;
  target: string;
  intervalSeconds: number;
}

/** The retainer in words: what arrives every month without being asked for. */
export interface DeliveryReportCare {
  packageName: string;
  covers: string[];
}

export interface DeliveryReport {
  project: ProjectRow;
  clientName: string;
  phases: DeliveryReportPhase[];
  milestones: DeliveryReportMilestone[];
  sites: DeliveryReportSite[];
  screenshots: CaseStudyScreenshots;
  /** Named, never opened. */
  access: AccessLocation[];
  monitors: DeliveryReportMonitor[];
  care: DeliveryReportCare | null;
  progress: ProjectProgress;
  progressSentence: string;
  /** Present once the client has signed, and printed on the countersigned copy. */
  signOff: DeliverySignOffRow | null;
}

/** The care plan in a client's words rather than a jsonb key's. */
function coversFrom(includes: PackageIncludes): string[] {
  const covers: string[] = [];
  if (includes.website) covers.push("Hosting, updates and backups for your website");
  if (includes.seo) covers.push("Ongoing search engine work");
  if (includes.ads) covers.push("Managing your advertising");
  const each = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many} a month`;
  if (includes.socialPostsPerMonth > 0) covers.push(each(includes.socialPostsPerMonth, "social post", "social posts"));
  if (includes.blogPostsPerMonth > 0) covers.push(each(includes.blogPostsPerMonth, "blog post", "blog posts"));
  if (includes.gbpUpdatesPerMonth > 0) covers.push(each(includes.gbpUpdatesPerMonth, "Google Business update", "Google Business updates"));
  return covers;
}

/**
 * Compiles one project into everything the delivery report prints.
 *
 * Reads only; nothing here writes a row, so the admin page can render a
 * preview as often as it likes. `getProject` is reused wholesale rather than
 * re-querying phases and milestones — it is the four-statement read P4 built
 * for exactly this shape of page, and the progress figure the report quotes
 * has to be the same figure the portal shows.
 *
 * Internal milestones are dropped here rather than in the template: a document
 * that is emailed and forwarded is the last place to be relying on a view to
 * filter what a client may see.
 */
export async function buildDeliveryReport(db: Db, organisationId: string, input: BuildDeliveryReportInput): Promise<DeliveryReport> {
  const v = BuildDeliveryReportInput.parse(input);
  const detail = await getProject(db, organisationId, v.projectId);
  if (!detail) throw new DeliveryRefused("not_found", "That project could not be found.");
  const { project } = detail;

  const [client] = await db
    .select({ name: schema.clients.name, packageId: schema.clients.packageId })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, project.clientId), eq(schema.clients.organisationId, organisationId)));
  if (!client) throw new DeliveryRefused("not_found", "That project's client could not be found.");

  const sites = await db
    .select({ name: schema.sites.name, url: schema.sites.primaryUrl, status: schema.sites.status })
    .from(schema.sites)
    .where(and(
      eq(schema.sites.organisationId, organisationId),
      eq(schema.sites.clientId, project.clientId),
      isNull(schema.sites.deletedAt),
    ))
    .orderBy(asc(schema.sites.name), asc(schema.sites.createdAt));

  const monitors = await db
    .select({
      siteName: schema.sites.name,
      target: schema.monitors.target,
      intervalSeconds: schema.monitors.intervalSeconds,
    })
    .from(schema.monitors)
    .innerJoin(schema.sites, eq(schema.sites.id, schema.monitors.siteId))
    .where(and(
      eq(schema.monitors.organisationId, organisationId),
      eq(schema.sites.organisationId, organisationId),
      eq(schema.sites.clientId, project.clientId),
      eq(schema.monitors.enabled, true),
      isNull(schema.monitors.deletedAt),
    ))
    .orderBy(asc(schema.sites.name), asc(schema.monitors.target));

  // The launch photographs, taken by the screenshot job against the project's
  // own case study. An empty object is the ordinary case for a build whose
  // pictures have not been taken yet, and the template simply prints nothing.
  const [study] = await db
    .select({ screenshots: schema.caseStudies.screenshots })
    .from(schema.caseStudies)
    .where(and(
      eq(schema.caseStudies.organisationId, organisationId),
      eq(schema.caseStudies.projectId, project.id),
      isNull(schema.caseStudies.deletedAt),
    ));

  const [pkg] = client.packageId
    ? await db
      .select({ name: schema.packages.name, includes: schema.packages.includes })
      .from(schema.packages)
      .where(and(eq(schema.packages.id, client.packageId), eq(schema.packages.organisationId, organisationId)))
    : [undefined];

  return {
    project,
    clientName: client.name,
    phases: detail.phases.map((phase) => ({ name: phase.name, status: phase.status, doneAt: phase.doneAt })),
    milestones: detail.milestones
      .filter((milestone) => milestone.clientVisible)
      .map((milestone) => ({ title: milestone.title, detail: milestone.detail, reachedAt: milestone.reachedAt })),
    sites: sites.map((site) => ({ name: site.name, url: site.url, live: site.status === "live" })),
    screenshots: study?.screenshots ?? {},
    access: await listAccessLocations(db, organisationId, project.clientId),
    monitors,
    care: pkg ? { packageName: pkg.name, covers: coversFrom(pkg.includes) } : null,
    progress: detail.progress,
    progressSentence: describeProgress(detail.progress),
    signOff: await getDeliverySignOff(db, organisationId, project.id),
  };
}
