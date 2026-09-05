import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import { ChartColumn } from "lucide-react";
import Link from "next/link";
import Markdown from "react-markdown";
import { ActionForm } from "@/components/action-form";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { readSendFailure, type SendFailure } from "@/lib/send-status";
import { requireAdmin } from "@/lib/session";

import { approveAdReportAction, sendAdReportAction } from "../actions";

export const dynamic = "force-dynamic";

type ReportRow = {
  id: string;
  periodStart: string;
  periodEnd: string;
  summaryMd: string;
  status: string;
  agentRunId: string | null;
  createdAt: Date;
  sentAt: Date | null;
  metadata: Record<string, unknown>;
  accountId: string;
  accountName: string;
  clientId: string;
  clientName: string;
};

/**
 * A report whose email was rejected keeps its claim — a rollback would arm a
 * second send — so the badge still reads "sent". Without this note the only
 * signals are an owner notification and a client activity row, both of which
 * scroll away, and the screen quietly tells Shoji the client has the report.
 */
function SendFailureNote({ failure }: { failure: SendFailure | null }) {
  if (!failure) return null;
  return (
    <p className="mt-2 max-w-prose text-meta font-normal text-danger-fg">
      <span className="font-semibold">Send failed:</span> {failure.message}
      {failure.to ? <span className="block">to {failure.to}</span> : null}
      <span className="block text-muted-foreground">Draft a fresh report if the client still needs it.</span>
    </p>
  );
}

const COLUMNS: readonly DataListColumn<ReportRow>[] = [
  {
    key: "period",
    header: "Period",
    primary: true,
    cell: (report) => (
      <>
        <span className="whitespace-nowrap">
          {formatDate(report.periodStart)} → {formatDate(report.periodEnd)}
        </span>
        <SendFailureNote failure={readSendFailure(report.metadata)} />
      </>
    ),
  },
  {
    key: "client",
    header: "Client",
    cell: (report) => (
      <Link href={`/clients/${report.clientId}`} className="hover:underline">
        {report.clientName}
      </Link>
    ),
  },
  {
    key: "account",
    header: "Account",
    cell: (report) => (
      <Link href={`/ads/${report.accountId}`} className="hover:underline">
        {report.accountName}
      </Link>
    ),
  },
  {
    key: "drafted",
    header: "Drafted",
    hideOnMobile: true,
    cell: (report) => <span className="whitespace-nowrap">{formatDateTime(report.createdAt)}</span>,
  },
  {
    key: "run",
    header: "Agent run",
    hideOnMobile: true,
    cell: (report) =>
      report.agentRunId ? (
        <Link href={`/agents/runs/${report.agentRunId}`} className="underline hover:text-foreground">
          view run
        </Link>
      ) : (
        "—"
      ),
  },
  {
    key: "summary",
    header: "Summary",
    className: "text-left",
    cell: (report) => (
      <details className="group">
        <summary className="cursor-pointer text-muted-foreground group-open:text-foreground">Preview</summary>
        <div className="prose prose-sm mt-2 max-w-prose text-left text-foreground">
          <Markdown>{report.summaryMd}</Markdown>
        </div>
      </details>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (report) => <StatusBadge value={report.status} /> },
  {
    key: "actions",
    header: "Actions",
    action: true,
    cell: (report) => (
      <>
        {report.status === "draft" ? (
          <ActionForm
            action={approveAdReportAction}
            ariaLabel={`Approve the report for ${report.accountName}`}
            success="Report approved"
          >
            <input type="hidden" name="adReportId" value={report.id} />
            <Button type="submit" variant="success" size="sm">
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
            <Button type="submit" size="sm">
              Send
            </Button>
          </ActionForm>
        ) : null}
        {report.status === "sent" ? (
          <span className="text-meta text-muted-foreground">Sent {formatDateTime(report.sentAt)}</span>
        ) : null}
      </>
    ),
  },
];

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
        category="money"
      />

      <DataList<ReportRow>
        rows={reports}
        columns={COLUMNS}
        getRowKey={(report) => report.id}
        caption="Ad reports"
        empty={
          <EmptyState icon={ChartColumn}>
            No ad reports yet. The Ad Performance Sentinel drafts one when an account is flagged.
          </EmptyState>
        }
      />
    </>
  );
}
