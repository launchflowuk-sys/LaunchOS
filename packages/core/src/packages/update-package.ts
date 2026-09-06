import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { PackageIncludesInput } from "./create-package.js";

export const UpdatePackageInput = z.object({
  packageId: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullish(),
  monthlyPricePence: z.number().int().min(0).optional(),
  setupPricePence: z.number().int().min(0).optional(),
  includes: PackageIncludesInput.optional(),
  active: z.boolean().optional(),
  /**
   * The Stripe Price the self-serve signup sells this package under. Null
   * clears it, which puts the package back on the invoice flow; a blank
   * string from a form is the caller's to turn into null.
   */
  stripePriceId: z.string().trim().min(1).max(200).nullish(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type UpdatePackageInput = z.input<typeof UpdatePackageInput>;

export async function updatePackage(db: Db, organisationId: string, input: UpdatePackageInput) {
  const v = UpdatePackageInput.parse(input);
  const where = and(eq(schema.packages.id, v.packageId), eq(schema.packages.organisationId, organisationId));
  const [before] = await db.select().from(schema.packages).where(where);
  if (!before) throw new Error(`package ${v.packageId} not found in organisation`);

  // Immutable update: build the patch, never mutate `before`.
  const [after] = await db.update(schema.packages).set({
    ...(v.name === undefined ? {} : { name: v.name }),
    ...(v.description === undefined ? {} : { description: v.description ?? null }),
    ...(v.monthlyPricePence === undefined ? {} : { monthlyPricePence: v.monthlyPricePence }),
    ...(v.setupPricePence === undefined ? {} : { setupPricePence: v.setupPricePence }),
    ...(v.includes === undefined ? {} : { includes: v.includes }),
    ...(v.active === undefined ? {} : { active: v.active }),
    ...(v.stripePriceId === undefined ? {} : { stripePriceId: v.stripePriceId ?? null }),
    updatedAt: new Date(),
  }).where(where).returning();

  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "package.updated",
    targetType: "package", targetId: v.packageId, before, after,
  });
  return after!;
}
