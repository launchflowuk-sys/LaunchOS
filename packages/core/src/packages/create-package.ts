import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const PackageIncludesInput = z.object({
  website: z.boolean().default(false),
  seo: z.boolean().default(false),
  ads: z.boolean().default(false),
  socialPostsPerMonth: z.number().int().min(0).max(60).default(0),
  blogPostsPerMonth: z.number().int().min(0).max(60).default(0),
  gbpUpdatesPerMonth: z.number().int().min(0).max(60).default(0),
});

export const CreatePackageInput = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, digits and hyphens"),
  description: z.string().max(2000).optional(),
  monthlyPricePence: z.number().int().min(0).default(0),
  setupPricePence: z.number().int().min(0).default(0),
  currency: z.string().length(3).default("GBP"),
  // Zod 4's object `.default()` expects the fully-resolved output shape, not
  // a partial — even though every field below carries its own default.
  includes: PackageIncludesInput.default(schema.PACKAGE_INCLUDES_DEFAULT),
  active: z.boolean().default(true),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type CreatePackageInput = z.input<typeof CreatePackageInput>;

export async function createPackage(db: Db, organisationId: string, input: CreatePackageInput) {
  const v = CreatePackageInput.parse(input);
  const [pkg] = await db.insert(schema.packages).values({
    organisationId, name: v.name, slug: v.slug, description: v.description ?? null,
    monthlyPricePence: v.monthlyPricePence, setupPricePence: v.setupPricePence,
    currency: v.currency, includes: v.includes, active: v.active,
  }).returning();
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "package.created",
    targetType: "package", targetId: pkg!.id, after: pkg,
  });
  return pkg!;
}
