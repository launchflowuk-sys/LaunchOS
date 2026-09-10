import {
  advanceSiteBuild, activeSiteBuilds, briefFromLead, notifyOwner,
  type SiteBuildRow,
} from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import {
  filesFromGeneratedSite, provisionWordPressWebsite,
  type HostingProvisioner, type SiteGeneratorAdapter, type SiteUploader,
} from "@launchos/integrations";
import { and, eq } from "drizzle-orm";

/**
 * Drives a build one stage at a time.
 *
 * One stage per tick, on purpose. Each stage is minutes long and can fail on
 * its own, and doing them in a single pass means a restart loses the lot — with
 * a website already created on the host and nothing left pointing at it. One
 * stage per tick means the row always says where things got to, and the next
 * tick carries on from there.
 *
 * **It stops at `review` and does not resume by itself.** That is the whole
 * design: the site is built, working and visible to us, and the client has been
 * told nothing. Moving past review is a person's decision, taken in Approvals.
 */

export interface SiteBuildDeps {
  db: Db;
  host: HostingProvisioner;
  generator: SiteGeneratorAdapter;
  uploader: SiteUploader;
  /** The hosting plan new websites are created under. */
  orderId: number;
  /** Admin credentials for the WordPress install. Generated per build by the caller. */
  makeAdminPassword: () => string;
  logger?: Pick<Console, "info" | "error"> | undefined;
}

export interface SiteBuildResult {
  advanced: number;
  failed: number;
  /** Builds now sitting at review, waiting on a person. */
  awaitingReview: number;
}

/** One tick over every build that is still going somewhere. */
export async function runSiteBuilds(
  deps: SiteBuildDeps,
  organisationId: string,
  now: Date = new Date(),
): Promise<SiteBuildResult> {
  const logger = deps.logger ?? console;
  const builds = await activeSiteBuilds(deps.db, organisationId);

  let advanced = 0;
  let failed = 0;
  let awaitingReview = 0;

  for (const build of builds) {
    // Stages waiting on a human are not the job's business.
    if (build.stage === "review" || build.stage === "approved") {
      if (build.stage === "review") awaitingReview += 1;
      continue;
    }

    try {
      const moved = await advanceOne(deps, organisationId, build, now);
      if (moved) advanced += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Recorded on the row rather than thrown. One build that fails must not
      // stop the others, and the row is what teardown reads afterwards.
      await advanceSiteBuild(deps.db, organisationId, build.id, "failed", { error: reason });
      logger.error({ organisationId, buildId: build.id, domain: build.domain, error: reason }, "site build failed");
      failed += 1;
    }
  }

  const result: SiteBuildResult = { advanced, failed, awaitingReview };
  logger.info({ organisationId, ...result }, "site builds");
  return result;
}

/** Moves one build forward by exactly one stage. Returns whether it moved. */
async function advanceOne(
  deps: SiteBuildDeps,
  organisationId: string,
  build: SiteBuildRow,
  now: Date,
): Promise<boolean> {
  switch (build.stage) {
    case "queued": {
      await advanceSiteBuild(deps.db, organisationId, build.id, "generating");
      return true;
    }

    case "generating": {
      if (!build.leadId) throw new Error("the build has no lead to write a brief from");
      const { brief } = await briefFromLead(deps.db, organisationId, build.leadId);
      const site = await deps.generator.generate(brief);
      await advanceSiteBuild(deps.db, organisationId, build.id, "provisioning", {
        generated: site as unknown as Record<string, unknown>,
        generatorModel: site.model,
      });
      return true;
    }

    case "provisioning": {
      const result = await provisionWordPressWebsite(deps.host, {
        orderId: deps.orderId,
        username: build.hostingUsername ?? "",
        domain: build.domain,
        siteTitle: siteTitleFor(build),
        adminEmail: `builds@${build.domain}`,
        adminUser: "launchflow",
        adminPassword: deps.makeAdminPassword(),
        language: "en_GB",
        autoUpdates: "minor",
      });

      if (result.status === "failed") throw new Error(result.failureReason ?? "provisioning failed");

      const site = (await deps.host.listWebsites()).find((row) => row.domain === build.domain);
      await advanceSiteBuild(deps.db, organisationId, build.id, "uploading", {
        hostingUsername: site?.username ?? null,
        rootDirectory: site?.rootDirectory ?? null,
        websiteUrl: result.websiteUrl,
        adminUrl: result.adminUrl,
      });
      return true;
    }

    case "uploading": {
      const generated = build.generated as { pages?: unknown; css?: unknown } | null;
      if (!generated?.pages) throw new Error("the build has nothing generated to upload");
      if (!build.rootDirectory) throw new Error("the build has no document root to upload into");

      const files = filesFromGeneratedSite({
        pages: generated.pages as { path: string; title: string; html: string }[],
        css: typeof generated.css === "string" ? generated.css : "",
      });
      await deps.uploader.upload(build.rootDirectory, files);

      await advanceSiteBuild(deps.db, organisationId, build.id, "review");

      // The owner is told the moment it is ready to look at — this is the
      // point of the whole chain, and a build nobody knows about is a build
      // that sits at review for a week.
      await notifyOwner(deps.db, organisationId, {
        kind: "site_build.review",
        title: `A site is ready to check: ${build.domain}`,
        body: `${files.length} pages built and uploaded. Nothing has been sent to the client.`,
        link: `/site-builds`,
      });
      return true;
    }

    default:
      return false;
  }
}

/** The client's name where we have one, the domain otherwise. */
function siteTitleFor(build: SiteBuildRow): string {
  return build.domain.split(".")[0]!.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Looks up the client's name for a nicer title, when the build has a client. */
export async function clientNameFor(db: Db, organisationId: string, clientId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: schema.clients.name })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId)));
  return row?.name ?? null;
}
