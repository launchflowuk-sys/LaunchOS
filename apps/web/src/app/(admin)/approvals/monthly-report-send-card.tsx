import {
  monthlyReportDocumentHtml,
  monthlyReportMonthName,
  MonthlyReportSendPayload,
  monthlyReportTitle,
} from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { FileText } from "lucide-react";
import Link from "next/link";
import { DocumentPreview } from "@/components/document-preview";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

/**
 * A month's account report asking to be emailed to the client.
 *
 * The card shows **the document itself**, rendered from the `client_reports`
 * row by the same function the worker prints, not a description of it. That
 * is the rule the proposal, content and lead-reply cards all follow, and it is
 * what makes "read what will actually go out" true rather than intended.
 *
 * **The payload names the report and nothing else is trusted from it.** The
 * client, the month, the figures and the file are read from our own rows at
 * render time — `MonthlyReportSendPayload` is core's own schema, imported
 * rather than re-declared here, exactly as `ProposalSendPayload` is on the
 * card beside it, so what the gate writes and what this screen reads cannot
 * drift.
 */

export async function MonthlyReportSendRequest({ approval }: { approval: typeof schema.approvals.$inferSelect }) {
  const payload = MonthlyReportSendPayload.safeParse(approval.payload);
  if (!payload.success) {
    return (
      <InlineAlert tone="danger" title="This request cannot be shown">
        The stored request does not match what this screen expects, so approve nothing until it has been checked from
        the Reports screen.
      </InlineAlert>
    );
  }

  const session = await requireAdmin();
  const [row] = await getDb()
    .select({ report: schema.clientReports, clientName: schema.clients.name })
    .from(schema.clientReports)
    .innerJoin(schema.clients, eq(schema.clientReports.clientId, schema.clients.id))
    .where(and(
      eq(schema.clientReports.id, payload.data.reportId),
      eq(schema.clientReports.organisationId, session.organisationId),
    ));
  if (!row) {
    return (
      <InlineAlert tone="danger" title="That report is gone">
        The report this request points at no longer exists. Reject the request.
      </InlineAlert>
    );
  }

  const { report, clientName } = row;
  // Core's own reading of the month, so the card, the PDF and the email
  // heading all say the same words.
  const monthName = monthlyReportMonthName(report);
  const rendered = report.documentId !== null;

  return (
    <>
      <InlineAlert tone={rendered ? "warning" : "danger"} title="What approving does">
        {rendered ? (
          <>
            Emails {clientName} their {monthName} account report — uptime, content, support, ads and invoices for the
            month — with a private link to the PDF below. Rejecting sends nothing and leaves the report where it is.
          </>
        ) : (
          <>
            This report has no PDF yet, so there is nothing to link. The worker prints it before raising the send;
            if it is still missing, reject this and look at the report before it goes anywhere.
          </>
        )}
      </InlineAlert>

      <KeyValue
        columns={2}
        items={[
          {
            label: "Client",
            value: (
              <Link href={`/clients/${report.clientId}/reports`} className="text-primary underline underline-offset-2">
                {clientName}
              </Link>
            ),
          },
          { label: "Month", value: monthName },
          { label: "Period", value: `${formatDate(report.periodStart)} → ${formatDate(report.periodEnd)}` },
          { label: "Report status", value: report.status === "published" ? "Published to their portal" : "Draft" },
        ]}
      />

      <DocumentPreview
        html={monthlyReportDocumentHtml({ report, clientName, monthName })}
        title={monthlyReportTitle(monthName)}
      />

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="secondary">
          <Link href={`/reports/${report.id}`}>
            <FileText aria-hidden /> Open the report
          </Link>
        </Button>
        {rendered ? (
          <Button asChild variant="secondary">
            <a href={`/api/documents/${report.documentId}`}>Open the PDF</a>
          </Button>
        ) : null}
      </div>
    </>
  );
}
