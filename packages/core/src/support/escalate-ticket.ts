import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { notifyOwner } from "../notifications/notify.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { slaDueAt } from "./sla.js";

export const EscalateTicketInput = z.object({
  ticketId: z.string().uuid(),
  reason: z.string().min(1).max(1000),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type EscalateTicketInput = z.input<typeof EscalateTicketInput>;

/** Anything already high or critical keeps its severity — escalation never de-escalates. */
const RAISEABLE: readonly string[] = ["low", "medium"];

export async function escalateTicket(db: Db, organisationId: string, input: EscalateTicketInput) {
  const v = EscalateTicketInput.parse(input);
  await assertOwned(db, organisationId, schema.tickets, v.ticketId);

  const where = and(eq(schema.tickets.id, v.ticketId), eq(schema.tickets.organisationId, organisationId));
  const [before] = await db.select().from(schema.tickets).where(where);
  if (!before) throw new Error(`ticket ${v.ticketId} not found in organisation`);

  const raise = RAISEABLE.includes(before.severity);
  const [after] = await db
    .update(schema.tickets)
    .set({
      escalated: true,
      escalationReason: v.reason,
      severity: raise ? "high" : before.severity,
      slaDueAt: raise ? slaDueAt("high", before.createdAt) : before.slaDueAt,
      updatedAt: new Date(),
    })
    .where(where)
    .returning();

  await db.insert(schema.ticketEvents).values({
    organisationId, ticketId: v.ticketId, kind: "escalated",
    actorKind: v.actorKind, actorId: v.actorId ?? null, data: { reason: v.reason },
  });
  await recordAudit(db, organisationId, {
    actorKind: v.actorKind, actorId: v.actorId, action: "ticket.escalated",
    targetType: "ticket", targetId: v.ticketId, before, after,
  });
  await notifyOwner(db, organisationId, {
    kind: "support.escalated",
    title: `Escalated: ${after!.subject}`,
    body: v.reason,
    link: `/cases/${v.ticketId}`,
  });
  return after!;
}
