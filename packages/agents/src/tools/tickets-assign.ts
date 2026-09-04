import { assignTicket } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export const ticketsAssign = defineTool({
  name: "tickets_assign",
  description: "Assign this ticket to the least-loaded active staff member.",
  input: z.object({ ticketId: z.string().uuid() }),
  risk: "safe",
  execute: async (input, ctx) => {
    const ticket = await assignTicket(ctx.db, ctx.organisationId, { ...input, actorKind: "agent", actorId: "support-triage" });
    return { ticketId: ticket.id, assignedUserId: ticket.assignedUserId };
  },
});
