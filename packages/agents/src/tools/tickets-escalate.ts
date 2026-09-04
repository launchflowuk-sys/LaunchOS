import { escalateTicket } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export const ticketsEscalate = defineTool({
  name: "tickets_escalate",
  description: "Mark a ticket escalated and notify the owner. Escalation never lowers severity.",
  input: z.object({ ticketId: z.string().uuid(), reason: z.string().min(1).max(1000) }),
  risk: "safe",
  execute: async (input, ctx) => {
    await escalateTicket(ctx.db, ctx.organisationId, { ...input, actorKind: "agent", actorId: "support-triage" });
    return { ticketId: input.ticketId, escalated: true };
  },
});
