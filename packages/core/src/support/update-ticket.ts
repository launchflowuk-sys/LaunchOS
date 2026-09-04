import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { slaDueAt, type Severity } from "./sla.js";

export const TicketTriageSchema = z.object({
  category: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string().min(1),
  suggestedFix: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const UpdateTicketInput = z.object({
  ticketId: z.string().uuid(),
  category: z.enum(["hosting", "dns", "content", "email", "ads", "billing", "other"]).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  status: z.enum(["open", "triaged", "in_progress", "waiting_client", "resolved", "closed"]).optional(),
  triage: TicketTriageSchema.optional(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
});
export type UpdateTicketInput = z.input<typeof UpdateTicketInput>;

const CLOSING = new Set(["resolved", "closed"]);

export async function updateTicket(db: Db, organisationId: string, input: UpdateTicketInput) {
  const v = UpdateTicketInput.parse(input);
  await assertOwned(db, organisationId, schema.tickets, v.ticketId);

  const where = and(eq(schema.tickets.id, v.ticketId), eq(schema.tickets.organisationId, organisationId));

  // The row, its ticket_events entry and its audit row move together: a status
  // change with no event behind it is a case history that quietly lies.
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [before] = await tx.select().from(schema.tickets).where(where);
    if (!before) throw new Error(`ticket ${v.ticketId} not found in organisation`);

    const severity = (v.severity ?? before.severity) as Severity;
    const [after] = await tx
      .update(schema.tickets)
      .set({
        category: v.category ?? before.category,
        severity,
        status: v.status ?? before.status,
        triage: v.triage ?? before.triage,
        // Severity *is* the SLA: change one and the other follows.
        slaDueAt: v.severity ? slaDueAt(severity, before.createdAt) : before.slaDueAt,
        resolvedAt: v.status && CLOSING.has(v.status) ? (before.resolvedAt ?? new Date()) : before.resolvedAt,
        updatedAt: new Date(),
      })
      .where(where)
      .returning();

    if (v.status && v.status !== before.status) {
      await tx.insert(schema.ticketEvents).values({
        organisationId, ticketId: v.ticketId, kind: "status_changed",
        actorKind: v.actorKind, actorId: v.actorId ?? null, data: { from: before.status, to: v.status },
      });
    }
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "ticket.updated",
      targetType: "ticket", targetId: v.ticketId, before, after,
    });
    return after!;
  });
}
