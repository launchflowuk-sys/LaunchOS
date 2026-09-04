import { createTask } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export const tasksCreate = defineTool({
  name: "tasks_create",
  description: "Create a support task linked to this ticket so a human picks up the work.",
  input: z.object({
    ticketId: z.string().uuid(),
    title: z.string().min(1).max(200),
    kind: z.enum(["build", "deploy", "dns", "seo", "content", "social", "gbp", "review", "handover", "support", "billing", "other"]).default("support"),
    priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    descriptionMd: z.string().optional(),
  }),
  risk: "safe",
  execute: async (input, ctx) => {
    // The client (and site, if any) come from the ticket itself, org-scoped,
    // never from the model — otherwise a triage run could file a task
    // against any client id it happened to name, not just the ticket's own.
    const [ticket] = await ctx.db
      .select({ clientId: schema.tickets.clientId, siteId: schema.tickets.siteId })
      .from(schema.tickets)
      .where(and(eq(schema.tickets.id, input.ticketId), eq(schema.tickets.organisationId, ctx.organisationId)));
    if (!ticket) throw new Error(`ticket ${input.ticketId} not found in organisation`);

    const task = await createTask(ctx.db, ctx.organisationId, {
      clientId: ticket.clientId,
      siteId: ticket.siteId ?? undefined,
      ticketId: input.ticketId,
      title: input.title,
      kind: input.kind,
      priority: input.priority,
      descriptionMd: input.descriptionMd,
      phase: "support",
      clientVisible: false,
      actorKind: "agent",
      actorId: "support-triage",
    });
    return { taskId: task.id };
  },
});
