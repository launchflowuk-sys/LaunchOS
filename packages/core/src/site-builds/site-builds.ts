import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { SiteBuildStage } from "@launchos/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

/**
 * The record of a build, and the only thing that moves it between stages.
 *
 * Every stage is a separate write, so a worker that dies mid-chain leaves a row
 * saying exactly where it got to rather than nothing at all. That is what makes
 * the process resumable, and — more importantly — what makes an orphaned
 * website findable: a build stuck at `provisioning` names the hosting that
 * needs tearing down.
 */

export type SiteBuildRow = typeof schema.siteBuilds.$inferSelect;

/** Stages a build can still move on from. Anything else is finished, one way or another. */
export const ACTIVE_STAGES: readonly SiteBuildStage[] = [
  "queued", "generating", "provisioning", "uploading", "review", "approved",
];

export const StartSiteBuildInput = z.object({
  leadId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  /** A review domain of ours. Never the client's own — see the schema comment. */
  domain: z.string().trim().min(3).max(253).toLowerCase(),
  actorId: z.string().min(1).optional(),
});
export type StartSiteBuildInput = z.input<typeof StartSiteBuildInput>;

/**
 * Starts a build, or hands back the one already running for this domain.
 *
 * Deliberately not an error when one exists. The caller is usually a person
 * pressing a button twice, or a job retrying; neither should produce a second
 * build against the same hosting, and neither deserves a failure for asking.
 */
export async function startSiteBuild(
  db: Db,
  organisationId: string,
  input: StartSiteBuildInput,
): Promise<{ build: SiteBuildRow; created: boolean }> {
  const v = StartSiteBuildInput.parse(input);

  const [existing] = await db
    .select()
    .from(schema.siteBuilds)
    .where(and(eq(schema.siteBuilds.organisationId, organisationId), eq(schema.siteBuilds.domain, v.domain)));
  if (existing) return { build: existing, created: false };

  const [build] = await db
    .insert(schema.siteBuilds)
    .values({
      organisationId,
      domain: v.domain,
      ...(v.leadId ? { leadId: v.leadId } : {}),
      ...(v.clientId ? { clientId: v.clientId } : {}),
      stage: "queued",
    })
    .returning();

  await recordAudit(db, organisationId, {
    actorKind: v.actorId ? "user" : "system",
    ...(v.actorId ? { actorId: v.actorId } : {}),
    action: "site_build.started",
    targetType: "site_build",
    targetId: build!.id,
    after: { domain: v.domain, stage: "queued" },
  });

  return { build: build!, created: true };
}

export interface AdvanceFields {
  hostingUsername?: string | null;
  rootDirectory?: string | null;
  websiteUrl?: string | null;
  adminUrl?: string | null;
  generatorModel?: string | null;
  generated?: Record<string, unknown> | null;
  error?: string | null;
  approvalId?: string | null;
}

/**
 * Moves a build to a stage and records what that stage produced.
 *
 * Audited every time. A build that reached a client is a thing somebody will
 * ask about later — when it was approved, by whom, and what was on it — and the
 * row alone only holds the latest state.
 */
export async function advanceSiteBuild(
  db: Db,
  organisationId: string,
  buildId: string,
  stage: SiteBuildStage,
  fields: AdvanceFields = {},
  actorId?: string,
): Promise<SiteBuildRow> {
  const [before] = await db
    .select()
    .from(schema.siteBuilds)
    .where(and(eq(schema.siteBuilds.id, buildId), eq(schema.siteBuilds.organisationId, organisationId)));
  if (!before) throw new Error("that build could not be found");

  const now = new Date();
  const [after] = await db
    .update(schema.siteBuilds)
    .set({
      stage,
      ...fields,
      // Stamped from the stage rather than by the caller, so the timestamps
      // cannot disagree with the stage they describe.
      ...(stage === "review" ? { reviewReadyAt: now } : {}),
      ...(stage === "approved" ? { approvedAt: now } : {}),
      ...(stage === "notified" ? { notifiedAt: now } : {}),
      // A stage that is not a failure clears the last failure's words, so an
      // old error cannot be read as the current state.
      ...(stage === "failed" ? {} : fields.error === undefined ? { error: null } : {}),
      updatedAt: now,
    })
    .where(and(eq(schema.siteBuilds.id, buildId), eq(schema.siteBuilds.organisationId, organisationId)))
    .returning();

  await recordAudit(db, organisationId, {
    actorKind: actorId ? "user" : "system",
    ...(actorId ? { actorId } : {}),
    action: `site_build.${stage}`,
    targetType: "site_build",
    targetId: buildId,
    before: { stage: before.stage },
    after: { stage, ...(fields.error ? { error: fields.error } : {}) },
  });

  return after!;
}

/** Builds still on their way somewhere, oldest first — the worker's queue. */
export async function activeSiteBuilds(db: Db, organisationId: string): Promise<SiteBuildRow[]> {
  return db
    .select()
    .from(schema.siteBuilds)
    .where(and(
      eq(schema.siteBuilds.organisationId, organisationId),
      inArray(schema.siteBuilds.stage, [...ACTIVE_STAGES]),
    ))
    .orderBy(schema.siteBuilds.createdAt);
}

/**
 * Builds that provisioned hosting and then stopped.
 *
 * The orphan list. A failed or cancelled build that got as far as creating a
 * website has left one on the host, and nothing else will ever remove it. This
 * is what teardown reads — written now rather than later, because a pipeline
 * that leaks websites fills a disk that has already hit 84% twice in two days.
 */
export async function abandonedWithHosting(db: Db, organisationId: string): Promise<SiteBuildRow[]> {
  const rows = await db
    .select()
    .from(schema.siteBuilds)
    .where(and(
      eq(schema.siteBuilds.organisationId, organisationId),
      inArray(schema.siteBuilds.stage, ["failed", "cancelled"]),
    ));
  return rows.filter((row) => row.hostingUsername !== null);
}
