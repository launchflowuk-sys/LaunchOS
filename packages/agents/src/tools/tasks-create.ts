import { createTask } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export const tasksCreate = defineTool({
  name: "tasks_create",
  description: "Create a support task linked to this ticket so a human picks up the work.",
  input: z.object({
    clientId: z.string().uuid(),
    ticketId: z.string().uuid(),
    siteId: z.string().uuid().optional(),
    title: z.string().min(1).max(200),
    kind: z.enum(["build", "deploy", "dns", "seo", "content", "social", "gbp", "review", "handover", "support", "billing", "other"]).default("support"),
    priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    descriptionMd: z.string().optional(),
  }),
  risk: "safe",
  execute: async (input, ctx) => {
    const task = await createTask(ctx.db, ctx.organisationId, {
      ...input, phase: "support", clientVisible: false, actorKind: "agent", actorId: "support-triage",
    });
    return { taskId: task.id };
  },
});
