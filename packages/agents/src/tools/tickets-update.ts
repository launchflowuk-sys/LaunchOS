import { TicketTriageSchema, updateTicket } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export const ticketsUpdate = defineTool({
  name: "tickets_update",
  description: "Set a ticket's category, severity, status and the triage summary. Use status \"triaged\" once you have classified it.",
  input: z.object({
    ticketId: z.string().uuid(),
    category: z.enum(["hosting", "dns", "content", "email", "ads", "billing", "other"]).optional(),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
    status: z.enum(["open", "triaged", "in_progress", "waiting_client"]).optional(),
    triage: TicketTriageSchema.optional(),
  }),
  risk: "safe",
  execute: async (input, ctx) => {
    const ticket = await updateTicket(ctx.db, ctx.organisationId, { ...input, actorKind: "agent", actorId: "support-triage" });
    return { ticketId: ticket.id, status: ticket.status, severity: ticket.severity, slaDueAt: ticket.slaDueAt?.toISOString() ?? null };
  },
});
