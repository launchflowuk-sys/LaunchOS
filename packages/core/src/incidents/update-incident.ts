import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";

export const UpdateIncidentInput = z.object({
  incidentId: z.string().uuid(),
  status: z.enum(["open", "acknowledged", "resolved"]).optional(),
  summaryMd: z.string().optional(),
  ticketId: z.string().uuid().optional(),
  agentRunId: z.string().uuid().optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type UpdateIncidentInput = z.input<typeof UpdateIncidentInput>;

export async function updateIncident(db: Db, organisationId: string, input: UpdateIncidentInput) {
  const { incidentId, actorKind, actorId, ...patch } = UpdateIncidentInput.parse(input);
  const where = and(eq(schema.incidents.id, incidentId), eq(schema.incidents.organisationId, organisationId));
  const [before] = await db.select().from(schema.incidents).where(where);
  if (!before) throw new Error(`incident ${incidentId} not found in organisation`);
  const resolvedAt = patch.status === "resolved" ? new Date() : before.resolvedAt;
  const [after] = await db.update(schema.incidents).set({ ...patch, resolvedAt, updatedAt: new Date() }).where(where).returning();
  await recordAudit(db, organisationId, { actorKind, actorId, action: "incident.updated", targetType: "incident", targetId: incidentId, before, after });
  return after!;
}
