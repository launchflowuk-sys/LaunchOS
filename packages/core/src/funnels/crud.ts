import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { defaultFunnelSteps, FunnelStepsSchema, FunnelSuccessSchema } from "./steps.js";

export type FunnelRow = typeof schema.funnels.$inferSelect;

/** A refusal a screen can print without translation. */
export class FunnelRefused extends Error {
  constructor(readonly reason: "not_found" | "slug_taken" | "not_published", message: string) {
    super(message);
    this.name = "FunnelRefused";
  }
}

const Slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "a slug is lower-case letters, numbers and hyphens");

const Actor = {
  actorKind: z.enum(["user", "system"]).default("user"),
  actorId: z.string().optional(),
};

export const CreateFunnelInput = z.object({
  name: z.string().trim().min(1).max(160),
  slug: Slug,
  clientId: z.string().uuid().optional(),
  headline: z.string().trim().max(200).default(""),
  subheadline: z.string().trim().max(400).default(""),
  steps: FunnelStepsSchema.optional(),
  success: FunnelSuccessSchema.optional(),
  /** Zero switches the hot-lead buzz off; anything above it is the score that earns one. */
  hotScore: z.number().int().min(0).max(1000).default(50),
  ...Actor,
});
export type CreateFunnelInput = z.input<typeof CreateFunnelInput>;

/**
 * A new funnel: a row and a form, never a deploy. It starts as a `draft` with
 * the six default screens (contact at three), so the moment it exists there is
 * something to walk through and edit rather than an empty shell.
 */
export async function createFunnel(db: Db, organisationId: string, input: CreateFunnelInput): Promise<FunnelRow> {
  const v = CreateFunnelInput.parse(input);
  if (v.clientId) await assertOwned(db, organisationId, schema.clients, v.clientId);
  await assertSlugFree(db, organisationId, v.slug);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.insert(schema.funnels).values({
      organisationId,
      clientId: v.clientId ?? null,
      slug: v.slug,
      name: v.name,
      headline: v.headline,
      subheadline: v.subheadline,
      steps: v.steps ?? defaultFunnelSteps(),
      ...(v.success ? { success: v.success } : {}),
      hotScore: v.hotScore,
    }).returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "funnel.created", targetType: "funnel", targetId: row!.id, after: row,
    });
    return row!;
  });
}

export const UpdateFunnelInput = z.object({
  funnelId: z.string().uuid(),
  name: z.string().trim().min(1).max(160).optional(),
  slug: Slug.optional(),
  clientId: z.string().uuid().nullable().optional(),
  headline: z.string().trim().max(200).optional(),
  subheadline: z.string().trim().max(400).optional(),
  steps: FunnelStepsSchema.optional(),
  success: FunnelSuccessSchema.optional(),
  hotScore: z.number().int().min(0).max(1000).optional(),
  ...Actor,
});
export type UpdateFunnelInput = z.input<typeof UpdateFunnelInput>;

/** Every field a form can change, in one audited write. Absent fields are left alone. */
export async function updateFunnel(db: Db, organisationId: string, input: UpdateFunnelInput): Promise<FunnelRow> {
  const v = UpdateFunnelInput.parse(input);
  const before = await getFunnel(db, organisationId, v.funnelId);
  if (!before) throw new FunnelRefused("not_found", "That funnel is not one of ours.");
  if (v.clientId) await assertOwned(db, organisationId, schema.clients, v.clientId);
  if (v.slug && v.slug !== before.slug) await assertSlugFree(db, organisationId, v.slug, v.funnelId);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.funnels)
      .set({
        ...(v.name === undefined ? {} : { name: v.name }),
        ...(v.slug === undefined ? {} : { slug: v.slug }),
        ...(v.clientId === undefined ? {} : { clientId: v.clientId }),
        ...(v.headline === undefined ? {} : { headline: v.headline }),
        ...(v.subheadline === undefined ? {} : { subheadline: v.subheadline }),
        ...(v.steps === undefined ? {} : { steps: v.steps }),
        ...(v.success === undefined ? {} : { success: v.success }),
        ...(v.hotScore === undefined ? {} : { hotScore: v.hotScore }),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.funnels.id, v.funnelId), eq(schema.funnels.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "funnel.updated", targetType: "funnel", targetId: v.funnelId, before, after,
    });
    return after!;
  });
}

export const SetFunnelStatusInput = z.object({
  funnelId: z.string().uuid(),
  status: z.enum(schema.funnelStatusEnum.enumValues),
  ...Actor,
});
export type SetFunnelStatusInput = z.input<typeof SetFunnelStatusInput>;

/**
 * Publish, unpublish, archive. Publishing re-validates the steps: a funnel is
 * editable as a draft in whatever half-finished state its author left it, and
 * the check that there is a contact step in the middle belongs at the moment
 * it goes in front of paid traffic.
 */
export async function setFunnelStatus(db: Db, organisationId: string, input: SetFunnelStatusInput): Promise<FunnelRow> {
  const v = SetFunnelStatusInput.parse(input);
  const before = await getFunnel(db, organisationId, v.funnelId);
  if (!before) throw new FunnelRefused("not_found", "That funnel is not one of ours.");
  if (v.status === "published") {
    const parsed = FunnelStepsSchema.safeParse(before.steps);
    if (!parsed.success) {
      throw new FunnelRefused("not_published", parsed.error.issues[0]?.message ?? "This funnel's steps are not ready to publish.");
    }
  }
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [after] = await tx.update(schema.funnels)
      .set({ status: v.status, updatedAt: new Date() })
      .where(and(eq(schema.funnels.id, v.funnelId), eq(schema.funnels.organisationId, organisationId)))
      .returning();
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: `funnel.${v.status}`, targetType: "funnel", targetId: v.funnelId, before, after,
    });
    return after!;
  });
}

export async function getFunnel(db: Db, organisationId: string, funnelId: string): Promise<FunnelRow | null> {
  const [row] = await db.select().from(schema.funnels)
    .where(and(eq(schema.funnels.id, funnelId), eq(schema.funnels.organisationId, organisationId), isNull(schema.funnels.deletedAt)));
  return row ?? null;
}

export const ListFunnelsInput = z.object({
  status: z.enum(schema.funnelStatusEnum.enumValues).optional(),
  clientId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListFunnelsInput = z.input<typeof ListFunnelsInput>;

export async function listFunnels(db: Db, organisationId: string, input: ListFunnelsInput = {}): Promise<FunnelRow[]> {
  const v = ListFunnelsInput.parse(input);
  return db.select().from(schema.funnels)
    .where(and(
      eq(schema.funnels.organisationId, organisationId),
      isNull(schema.funnels.deletedAt),
      v.status ? eq(schema.funnels.status, v.status) : undefined,
      v.clientId ? eq(schema.funnels.clientId, v.clientId) : undefined,
    ))
    .orderBy(asc(schema.funnels.name), desc(schema.funnels.createdAt))
    .limit(v.limit);
}

/**
 * The public page's only lookup: a published funnel by slug, with no
 * organisation to scope by because the visitor has no session. The slug is
 * unique per organisation, so a second organisation with the same slug would
 * be ambiguous — the oldest wins, which is the same single-tenant rule
 * `publicOrganisationId` applies, and the row carries its own
 * `organisationId` onward so nothing downstream has to guess.
 */
export async function publishedFunnelBySlug(db: Db, slug: string): Promise<FunnelRow | null> {
  const parsed = Slug.safeParse(slug);
  if (!parsed.success) return null;
  const [row] = await db.select().from(schema.funnels)
    .where(and(eq(schema.funnels.slug, parsed.data), eq(schema.funnels.status, "published"), isNull(schema.funnels.deletedAt)))
    .orderBy(asc(schema.funnels.createdAt))
    .limit(1);
  return row ?? null;
}

async function assertSlugFree(db: Db, organisationId: string, slug: string, exceptId?: string): Promise<void> {
  const [clash] = await db.select({ id: schema.funnels.id }).from(schema.funnels)
    .where(and(
      eq(schema.funnels.organisationId, organisationId),
      eq(schema.funnels.slug, slug),
      exceptId ? ne(schema.funnels.id, exceptId) : undefined,
    ));
  if (clash) throw new FunnelRefused("slug_taken", `A funnel already lives at /f/${slug}.`);
}
