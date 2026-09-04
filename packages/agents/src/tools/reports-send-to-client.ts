import { z } from "zod";
import type { EmailAdapter } from "@launchos/channels";
import { sendAdReport } from "@launchos/core";
import { defineTool } from "../kernel/types.js";

/**
 * Outward-facing: emails a client the portal link to an advertising report.
 * `requires_approval`, so the kernel parks the run and a human decides.
 */
export const reportsSendToClient = (email: EmailAdapter, portalBaseUrl: string) =>
  defineTool({
    name: "reports_send_to_client",
    description:
      "Email the client a link to their advertising report in the portal. Requires human approval before it sends.",
    input: z.object({
      adReportId: z.string().uuid(),
      adAccountId: z.string().uuid(),
    }),
    risk: "requires_approval",
    execute: async (input, ctx) => {
      const report = await sendAdReport(
        ctx.db,
        ctx.organisationId,
        { adReportId: input.adReportId, actorId: `agent:${ctx.runId}` },
        email,
        portalBaseUrl,
      );
      return { adReportId: report.id, status: report.status };
    },
  });
