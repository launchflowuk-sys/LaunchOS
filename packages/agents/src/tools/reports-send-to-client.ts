import { z } from "zod";
import type { EmailAdapter } from "@launchos/channels";
import { approveAdReport, sendAdReport } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { defineTool } from "../kernel/types.js";
import type { AgentContext } from "../kernel/types.js";

const Input = z.object({
  adReportId: z.string().uuid().describe("The adReportId returned by ads_save_draft_report."),
});

/** The report, its account and the client it would be emailed to — all from our own rows. */
async function loadReport(adReportId: string, ctx: AgentContext) {
  const [row] = await ctx.db
    .select({
      status: schema.adReports.status,
      periodStart: schema.adReports.periodStart,
      periodEnd: schema.adReports.periodEnd,
      summaryMd: schema.adReports.summaryMd,
      accountName: schema.adAccounts.name,
      clientName: schema.clients.name,
      clientEmail: schema.clients.email,
    })
    .from(schema.adReports)
    .innerJoin(schema.adAccounts, eq(schema.adReports.adAccountId, schema.adAccounts.id))
    .innerJoin(schema.clients, eq(schema.adAccounts.clientId, schema.clients.id))
    .where(and(eq(schema.adReports.id, adReportId), eq(schema.adReports.organisationId, ctx.organisationId)));
  return row;
}

/**
 * Outward-facing: emails a client the portal link to an advertising report.
 * `requires_approval`, so the kernel parks the run and a human decides.
 *
 * The kernel's approval *is* the human decision the report was waiting for, so
 * this stamps the report `approved` before sending — `sendAdReport` ships an
 * `approved` row and nothing else. `describeApproval` is what makes that
 * honest: the approver reads the period, the client, the recipient address and
 * the whole summary before they release it, and the approval is attributed to
 * them (`ctx.approvedByUserId`) rather than to the agent.
 *
 * The approve is skipped for a report a person already approved on /ads/reports,
 * so the audit log never carries a second, no-op `ad_report.approved` row.
 */
export const reportsSendToClient = (email: EmailAdapter, portalBaseUrl: string) =>
  defineTool({
    name: "reports_send_to_client",
    description:
      "Email the client a link to their advertising report in the portal. Requires human approval before it sends. Send each report once: a report that has already gone out comes back as already_sent.",
    input: Input,
    risk: "requires_approval",
    describeApproval: async (input, ctx) => {
      const report = await loadReport(input.adReportId, ctx);
      if (!report) {
        return {
          title: "Send an advertising report that does not exist",
          summary: `No report ${input.adReportId} exists in this organisation. Approving it will fail.`,
        };
      }
      return {
        title: `Email ${report.clientName} their ${report.periodStart} to ${report.periodEnd} advertising report`,
        summary:
          `Approving emails ${report.clientEmail ?? "— no address on file, the send will fail —"} a link to ` +
          `${portalBaseUrl}/portal/reports and marks the report sent. It covers ${report.accountName} ` +
          `from ${report.periodStart} to ${report.periodEnd} and is currently ${report.status}.`,
        details: {
          client: report.clientName,
          recipientEmail: report.clientEmail ?? "(none on file)",
          adAccount: report.accountName,
          period: `${report.periodStart} to ${report.periodEnd}`,
          reportStatus: report.status,
          summaryMd: report.summaryMd,
        },
      };
    },
    execute: async (input, ctx) => {
      // A human released this tool call, so the send is theirs when the resume
      // knows who they were; an agent-run without an approver (a policy that
      // executes it directly) still falls back to naming the run.
      const action = ctx.approvedByUserId
        ? { adReportId: input.adReportId, actorId: ctx.approvedByUserId, actorKind: "user" as const }
        : { adReportId: input.adReportId, actorId: `agent:${ctx.runId}`, actorKind: "agent" as const };

      const report = await loadReport(input.adReportId, ctx);
      if (report?.status === "draft") {
        await approveAdReport(ctx.db, ctx.organisationId, action).catch((err: unknown) =>
          ctx.logger.warn("ad report approve skipped", {
            adReportId: input.adReportId,
            err: err instanceof Error ? err.message : String(err),
          }),
        );
      }

      const sent = await sendAdReport(ctx.db, ctx.organisationId, action, email, portalBaseUrl);
      return "alreadySent" in sent
        ? { adReportId: input.adReportId, status: "already_sent" as const }
        : { adReportId: input.adReportId, status: sent.status };
    },
  });
