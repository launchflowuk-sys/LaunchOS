import { z } from "zod";
import { saveDraftAdReport } from "@launchos/core";
import { defineTool } from "../kernel/types.js";

export const adsSaveDraftReport = defineTool({
  name: "ads_save_draft_report",
  description:
    "Save a client-facing Markdown advertising summary as a draft report. Drafts are never shown to the client until a human approves them.",
  input: z.object({
    adAccountId: z.string().uuid(),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    summaryMd: z.string().min(1),
  }),
  risk: "safe",
  execute: async (input, ctx) => {
    const report = await saveDraftAdReport(ctx.db, ctx.organisationId, { ...input, agentRunId: ctx.runId });
    return { adReportId: report.id, status: report.status };
  },
});
