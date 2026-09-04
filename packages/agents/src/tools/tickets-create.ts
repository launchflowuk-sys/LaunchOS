import { z } from "zod";
import { createTicket } from "@launchos/core";
import { defineTool } from "../kernel/types.js";

export const ticketsCreate = defineTool({
  name: "tickets_create",
  description: "Open an internal support ticket for a client's site.",
  input: z.object({
    clientId: z.string().uuid(),
    siteId: z.string().uuid().optional(),
    subject: z.string().min(1),
    body: z.string().min(1),
    severity: z.enum(["low", "medium", "high", "critical"]).default("high"),
    category: z.enum(["hosting", "dns", "content", "email", "ads", "billing", "other"]).default("hosting"),
  }),
  risk: "safe",
  execute: async (input, ctx) => {
    const result = await createTicket(ctx.db, ctx.organisationId, {
      ...input,
      source: "agent",
      actorKind: "agent",
      actorId: "hosting-guard-dog",
    });
    return { ticketId: result.ticket.id };
  },
});
