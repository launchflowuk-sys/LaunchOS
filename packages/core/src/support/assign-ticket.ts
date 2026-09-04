import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { pickLeastLoadedStaff } from "../tasks/assignee.js";
import { assertOrgMember, assertOwned } from "../tenancy/assert-owned.js";

export const AssignTicketInput = z.object({
  ticketId: z.string().uuid(),
  assignedUserId: z.string().min(1).optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type AssignTicketInput = z.input<typeof AssignTicketInput>;

/**
 * Explicit assignee, or the least-loaded active member when the caller (the
 * Support Triage agent's `tickets_assign` tool) has no opinion. The explicit
 * id arrives from outside the trust boundary, so it is checked against the
 * organisation's active membership before it is written.
 */
export async function assignTicket(db: Db, organisationId: string, input: AssignTicketInput) {
  const v = AssignTicketInput.parse(input);
  await assertOwned(db, organisationId, schema.tickets, v.ticketId);

  const assignedUserId = v.assignedUserId ?? (await pickLeastLoadedStaff(db, organisationId));
  if (!assignedUserId) throw new Error("no staff available to assign");
  await assertOrgMember(db, organisationId, assignedUserId);

  const where = and(eq(schema.tickets.id, v.ticketId), eq(schema.tickets.organisationId, organisationId));

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [before] = await tx.select().from(schema.tickets).where(where);
    if (!before) throw new Error(`ticket ${v.ticketId} not found in organisation`);

    const [after] = await tx
      .update(schema.tickets)
      .set({ assignedUserId, updatedAt: new Date() })
      .where(where)
      .returning();

    await tx.insert(schema.ticketEvents).values({
      organisationId, ticketId: v.ticketId, kind: "assigned",
      actorKind: v.actorKind, actorId: v.actorId ?? null,
      data: { from: before.assignedUserId, to: assignedUserId },
    });
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "ticket.assigned",
      targetType: "ticket", targetId: v.ticketId, before, after,
    });
    return after!;
  });
}
