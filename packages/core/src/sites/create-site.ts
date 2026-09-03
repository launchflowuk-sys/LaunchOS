import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const CreateSiteInput = z.object({ clientId: z.string().uuid(), name: z.string().min(1), primaryUrl: z.string().url() });
export type CreateSiteInput = z.infer<typeof CreateSiteInput>;

export async function createSite(db: Db, organisationId: string, input: CreateSiteInput) {
  const v = CreateSiteInput.parse(input);
  const [site] = await db.insert(schema.sites).values({ organisationId, ...v }).returning();
  await recordAudit(db, organisationId, { actorKind: "system", action: "site.created", targetType: "site", targetId: site!.id, after: site });
  return site!;
}
