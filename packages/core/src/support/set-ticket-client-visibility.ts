import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const SetTicketClientVisibilityInput = z.object({
  ticketId: z.string().uuid(),
  clientVisible: z.boolean(),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type SetTicketClientVisibilityInput = z.input<typeof SetTicketClientVisibilityInput>;

/**
 * Shares an internal case with the client, or takes it back.
 *
 * `tickets.client_visible` is what every portal read filters on and what
 * decides whether a staff reply has anywhere to land, so flipping it is a
 * decision about who can read a thread — not a field edit. It gets its own
 * function rather than a flag on `updateTicket`: an audit row that says
 * "ticket.updated" would bury it among severity and category changes, and the
 * case history is where a staff member looks to answer "when did the client
 * start seeing this?".
 *
 * Deliberately not exposed to agents: it is only ever called with
 * `actorKind: "user"` today, from the case screen.
 */
export async function setTicketClientVisibility(db: Db, organisationId: string, input: SetTicketClientVisibilityInput) {
  const v = SetTicketClientVisibilityInput.parse(input);
  await assertOwned(db, organisationId, schema.tickets, v.ticketId);

  const where = and(eq(schema.tickets.id, v.ticketId), eq(schema.tickets.organisationId, organisationId));

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [before] = await tx.select().from(schema.tickets).where(where);
    if (!before) throw new Error(`ticket ${v.ticketId} not found in organisation`);

    // A no-op still returns the row, but writes no history: a timeline of
    // "shared, shared, shared" from a double-clicked button tells nobody
    // anything.
    if (before.clientVisible === v.clientVisible) return before;

    const [after] = await tx
      .update(schema.tickets)
      .set({ clientVisible: v.clientVisible, updatedAt: new Date() })
      .where(where)
      .returning();

    await tx.insert(schema.ticketEvents).values({
      organisationId,
      ticketId: v.ticketId,
      kind: "note",
      actorKind: v.actorKind,
      actorId: v.actorId ?? null,
      data: { clientVisible: v.clientVisible, reason: v.clientVisible ? "shared with the client" : "hidden from the client" },
    });

    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind,
      actorId: v.actorId,
      action: v.clientVisible ? "ticket.shared_with_client" : "ticket.hidden_from_client",
      targetType: "ticket",
      targetId: v.ticketId,
      before,
      after,
    });
    return after!;
  });
}
