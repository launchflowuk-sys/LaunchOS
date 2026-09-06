import { attributionOf, bookingLinkFor, listLeadMessages } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

/**
 * The lead as the qualifier sees it: the enquiry, how it reached us, the
 * thread so far (the acknowledgement, any earlier reply), and whether this
 * person has been here before — earlier leads with the same email, and any
 * client record carrying it. All from our own rows; nothing here is the
 * model's.
 */
export const leadGet = defineTool({
  name: "lead_get",
  description:
    "Read a lead: name, business, message, source, campaign attribution, the booking link, the emails already on their thread, " +
    "and any previous leads or client records with the same email address.",
  input: z.object({ leadId: z.string().uuid() }),
  risk: "safe",
  execute: async ({ leadId }, ctx) => {
    const [lead] = await ctx.db.select().from(schema.leads)
      .where(and(eq(schema.leads.id, leadId), eq(schema.leads.organisationId, ctx.organisationId), isNull(schema.leads.deletedAt)));
    if (!lead) return { found: false as const, leadId };

    const previousLeads = lead.email
      ? await ctx.db.select({ id: schema.leads.id, status: schema.leads.status, source: schema.leads.source, business: schema.leads.business, message: schema.leads.message, createdAt: schema.leads.createdAt })
          .from(schema.leads)
          .where(and(eq(schema.leads.organisationId, ctx.organisationId), eq(schema.leads.email, lead.email), ne(schema.leads.id, lead.id), isNull(schema.leads.deletedAt)))
          .orderBy(desc(schema.leads.createdAt))
          .limit(5)
      : [];
    const existingClients = lead.email
      ? await ctx.db.select({ id: schema.clients.id, name: schema.clients.name, status: schema.clients.status })
          .from(schema.clients)
          .where(and(eq(schema.clients.organisationId, ctx.organisationId), eq(schema.clients.email, lead.email), isNull(schema.clients.deletedAt)))
          .limit(5)
      : [];
    const thread = await listLeadMessages(ctx.db, ctx.organisationId, lead.id);

    return {
      found: true as const,
      lead: {
        id: lead.id, name: lead.name, business: lead.business, email: lead.email, phone: lead.phone,
        message: lead.message, source: lead.source, status: lead.status, createdAt: lead.createdAt.toISOString(),
      },
      attribution: attributionOf(lead.metadata),
      bookingUrl: bookingLinkFor(lead),
      thread: thread.map((m) => ({ direction: m.direction, kind: m.metadata["kind"] ?? null, subject: m.subject, body: m.body, status: m.status, at: m.createdAt.toISOString() })),
      previousLeads: previousLeads.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
      existingClients,
    };
  },
});
