import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { emit } from "../events/emit.js";
import { assertSiteInOrganisation } from "../tenancy/assert-owned.js";

export const OpenIncidentInput = z.object({
  siteId: z.string().uuid(), monitorId: z.string().uuid().optional(), title: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]).default("high"),
});
export type OpenIncidentInput = z.input<typeof OpenIncidentInput>;

export async function openIncident(db: Db, organisationId: string, input: OpenIncidentInput) {
  const v = OpenIncidentInput.parse(input);
  await assertSiteInOrganisation(db, organisationId, v.siteId);
  const [incident] = await db.insert(schema.incidents).values({ organisationId, ...v, monitorId: v.monitorId ?? null }).returning();
  await recordAudit(db, organisationId, { actorKind: "system", action: "incident.opened", targetType: "incident", targetId: incident!.id, after: incident });
  await emit({ name: "incident.opened", organisationId, incidentId: incident!.id });
  return incident!;
}
