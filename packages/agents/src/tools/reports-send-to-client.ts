import { z } from "zod";
import type { EmailAdapter } from "@launchos/channels";
import { approveAdReport, sendAdReport } from "@launchos/core";
import { defineTool } from "../kernel/types.js";

/**
 * Outward-facing: emails a client the portal link to an advertising report.
 * `requires_approval`, so the kernel parks the run and a human decides.
 *
 * The kernel's approval *is* the human decision the report was waiting for, so
 * this stamps the report `approved` before sending — `sendAdReport` ships an
 * `approved` row and nothing else. `approveAdReport` refuses to reopen a report
 * that has already been sent; that is a no-op rather than a failure, and
 * `sendAdReport` is the one that says so (it re-validates ownership, status and
 * the client's address and throws for every other reason), so the approve error
 * is dropped here rather than matched on its text.
 */
export const reportsSendToClient = (email: EmailAdapter, portalBaseUrl: string) =>
  defineTool({
    name: "reports_send_to_client",
    description:
      "Email the client a link to their advertising report in the portal. Requires human approval before it sends. Send each report once: a report that has already gone out comes back as already_sent.",
    input: z.object({
      adReportId: z.string().uuid().describe("The adReportId returned by ads_save_draft_report."),
    }),
    risk: "requires_approval",
    execute: async (input, ctx) => {
      const action = { adReportId: input.adReportId, actorId: `agent:${ctx.runId}`, actorKind: "agent" as const };
      await approveAdReport(ctx.db, ctx.organisationId, action).catch(() => undefined);
      const report = await sendAdReport(ctx.db, ctx.organisationId, action, email, portalBaseUrl);
      return "alreadySent" in report
        ? { adReportId: input.adReportId, status: "already_sent" as const }
        : { adReportId: input.adReportId, status: report.status };
    },
  });
