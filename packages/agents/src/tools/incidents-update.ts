import { z } from "zod";
import { updateIncident } from "@launchos/core";
import { defineTool } from "../kernel/types.js";

export const incidentsUpdate = defineTool({
  name: "incidents_update",
  description: "Update an incident's status and Markdown summary.",
  input: z.object({
    incidentId: z.string().uuid(),
    status: z.enum(["open", "acknowledged", "resolved"]).optional(),
    summaryMd: z.string().optional(),
  }),
  risk: "safe",
  execute: async (input, ctx) =>
    updateIncident(ctx.db, ctx.organisationId, {
      ...input,
      agentRunId: ctx.runId,
      actorKind: "agent",
      actorId: "hosting-guard-dog",
    }),
});
