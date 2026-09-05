import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import Markdown from "react-markdown";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { readSendFailure, type SendFailure } from "@/lib/send-status";
import { requireAdmin } from "@/lib/session";
import { approveAdReportAction, sendAdReportAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function AdReportsPage() {
  const session = await requireAdmin();

  const reports = await getDb()
    .select({
      id: schema.adReports.id,
      periodStart: schema.adReports.periodStart,
      periodEnd: schema.adReports.periodEnd,
      summaryMd: schema.adReports.summaryMd,
      status: schema.adReports.status,
      agentRunId: schema.adReports.agentRunId,
      createdAt: schema.adReports.createdAt,
      sentAt: schema.adReports.sentAt,
      metadata: schema.adReports.metadata,
      accountId: schema.adAccounts.id,
      accountName: schema.adAccounts.name,
      clientId: schema.adAccounts.clientId,
      clientName: schema.clients.name,
    })
    .from(schema.adReports)
    .innerJoin(schema.adAccounts, eq(schema.adReports.adAccountId, schema.adAccounts.id))
    .innerJoin(schema.clients, eq(schema.adAccounts.clientId, schema.clients.id))
    .where(eq(schema.adReports.organisationId, session.organisationId))
    .orderBy(desc(schema.adReports.createdAt))
    .limit(100);

  return (
    <>
      <PageHeader
        title="Ad reports"
        description="Drafted by the Ad Performance Sentinel. Approve one before it can be emailed to the client."
      />

      {reports.length === 0 ? (
        <EmptyState>No ad reports yet. The Ad Performance Sentinel drafts one when an account is flagged.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Drafted</TableHead>
                <TableHead>Agent run</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => (
                <TableRow key={report.id}>
                  <TableCell className="whitespace-nowrap text-neutral-900">
                    {formatDate(report.periodStart)} → {formatDate(report.periodEnd)}
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs uppercase tracking-wide text-neutral-400">
                        Preview
                      </summary>
                      <div className="prose prose-sm mt-2 max-w-none text-neutral-700">
                        <Markdown>{report.summaryMd}</Markdown>
                      </div>
                    </details>
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    <Link href={`/clients/${report.clientId}`} className="hover:underline">
                      {report.clientName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    <Link href={`/ads/${report.accountId}`} className="hover:underline">
                      {report.accountName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={report.status} />
                    <SendFailureNote failure={readSendFailure(report.metadata)} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">
                    {formatDateTime(report.createdAt)}
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    {report.agentRunId ? (
                      <Link href={`/agents/runs/${report.agentRunId}`} className="underline">
                        view run
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {report.status === "draft" ? (
                      <ActionForm
                        action={approveAdReportAction}
                        ariaLabel={`Approve the report for ${report.accountName}`}
                        success="Report approved"
                      >
                        <input type="hidden" name="adReportId" value={report.id} />
                        <Button type="submit" variant="secondary">
                          Approve
                        </Button>
                      </ActionForm>
                    ) : null}
                    {report.status === "approved" ? (
                      <ActionForm
                        action={sendAdReportAction}
                        ariaLabel={`Send the report for ${report.accountName}`}
                        success="Report sent"
                      >
                        <input type="hidden" name="adReportId" value={report.id} />
                        <Button type="submit">Send</Button>
                      </ActionForm>
                    ) : null}
                    {report.status === "sent" ? (
                      <span className="text-xs text-neutral-400">Sent {formatDateTime(report.sentAt)}</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

/**
 * A report whose email was rejected keeps its claim — a rollback would arm a
 * second send — so the badge still reads "sent". Without this note the only
 * signals are an owner notification and a client activity row, both of which
 * scroll away, and the screen quietly tells Shoji the client has the report.
 */
function SendFailureNote({ failure }: { failure: SendFailure | null }) {
  if (!failure) return null;
  return (
    <p className="mt-1 max-w-xs text-xs text-red-700">
      <span className="font-semibold">Send failed:</span> {failure.message}
      {failure.to ? <span className="block text-red-600">to {failure.to}</span> : null}
      <span className="block text-neutral-500">Draft a fresh report if the client still needs it.</span>
    </p>
  );
}
