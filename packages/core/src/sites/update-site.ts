import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const UpdateSiteInput = z.object({
  siteId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  primaryUrl: z.string().url().optional(),
  platform: z.enum(["wordpress", "static", "nextjs", "other"]).optional(),
  hostingProvider: z.enum(["coolify", "other"]).optional(),
  hostingRef: z.string().max(200).nullish(),
  status: z.enum(["live", "building", "paused", "archived"]).optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type UpdateSiteInput = z.input<typeof UpdateSiteInput>;

export async function updateSite(db: Db, organisationId: string, input: UpdateSiteInput) {
  const { siteId, actorKind, actorId, ...patch } = UpdateSiteInput.parse(input);
  const where = and(eq(schema.sites.id, siteId), eq(schema.sites.organisationId, organisationId));

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.sites).where(where);
    if (!before) throw new Error(`site ${siteId} not found in organisation`);
    const [after] = await tx.update(schema.sites).set({ ...patch, updatedAt: new Date() }).where(where).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "site.updated", targetType: "site", targetId: siteId, before, after,
    });
    return after!;
  });
}
