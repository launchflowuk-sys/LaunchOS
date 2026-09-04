import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

const THREAD_LIMIT = 20;

export const ticketsGet = defineTool({
  name: "tickets_get",
  description: "Read one support ticket with its client, site and the last 20 messages on its conversation.",
  input: z.object({ ticketId: z.string().uuid() }),
  risk: "safe",
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .select({ ticket: schema.tickets, clientName: schema.clients.name, clientId: schema.clients.id })
      .from(schema.tickets)
      .innerJoin(schema.clients, eq(schema.tickets.clientId, schema.clients.id))
      .where(and(eq(schema.tickets.id, input.ticketId), eq(schema.tickets.organisationId, ctx.organisationId)));
    if (!row) throw new Error(`ticket ${input.ticketId} not found in organisation`);

    const messages = row.ticket.conversationId
      ? await ctx.db
          .select({
            direction: schema.messages.direction, authorKind: schema.messages.authorKind,
            body: schema.messages.body, createdAt: schema.messages.createdAt,
          })
          .from(schema.messages)
          .where(eq(schema.messages.conversationId, row.ticket.conversationId))
          .orderBy(asc(schema.messages.createdAt))
          .limit(THREAD_LIMIT)
      : [];

    return {
      ticket: {
        id: row.ticket.id, subject: row.ticket.subject, status: row.ticket.status, severity: row.ticket.severity,
        category: row.ticket.category, source: row.ticket.source, escalated: row.ticket.escalated,
        assignedUserId: row.ticket.assignedUserId, slaDueAt: row.ticket.slaDueAt?.toISOString() ?? null,
      },
      client: { id: row.clientId, name: row.clientName },
      conversationId: row.ticket.conversationId,
      siteId: row.ticket.siteId,
      messages,
    };
  },
});
