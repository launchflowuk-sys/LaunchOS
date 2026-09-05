import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import { Activity, FileText } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { DataList, type DataListColumn } from "@/components/data-list";
import { KeyValue } from "@/components/key-value";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { acknowledgeIncident, resolveIncident } from "./actions";

export const dynamic = "force-dynamic";

const RECENT_CHECK_LIMIT = 20;

type Check = typeof schema.uptimeChecks.$inferSelect;

const CHECK_COLUMNS: readonly DataListColumn<Check>[] = [
  {
    key: "checked",
    header: "Checked",
    primary: true,
    className: "whitespace-nowrap",
    cell: (check) => formatDateTime(check.checkedAt),
  },
  {
    key: "result",
    header: "Result",
    status: true,
    cell: (check) => <StatusBadge value={check.ok ? "up" : "down"} tone={check.ok ? "success" : "danger"} />,
  },
  { key: "code", header: "Status code", numeric: true, cell: (check) => check.statusCode ?? "—" },
  {
    key: "latency",
    header: "Latency",
    numeric: true,
    cell: (check) => (check.latencyMs === null ? "—" : `${check.latencyMs} ms`),
  },
  { key: "error", header: "Error", cell: (check) => check.error ?? "—" },
];

export default async function IncidentDetailPage({ params }: PageProps<"/incidents/[id]">) {
  const { id } = await params;
  const session = await requireAdmin();

  const [incident] = await getDb()
    .select({
      incident: schema.incidents,
      siteName: schema.sites.name,
      siteUrl: schema.sites.primaryUrl,
    })
    .from(schema.incidents)
    .innerJoin(schema.sites, eq(schema.incidents.siteId, schema.sites.id))
    .where(and(eq(schema.incidents.id, id), eq(schema.incidents.organisationId, session.organisationId)));

  if (!incident) notFound();

  const [ticket] = incident.incident.ticketId
    ? await getDb()
        .select()
        .from(schema.tickets)
        .where(
          and(
            eq(schema.tickets.id, incident.incident.ticketId),
            eq(schema.tickets.organisationId, session.organisationId),
          ),
        )
    : [];

  const checks = incident.incident.monitorId
    ? await getDb()
        .select()
        .from(schema.uptimeChecks)
        .where(
          and(
            eq(schema.uptimeChecks.monitorId, incident.incident.monitorId),
            eq(schema.uptimeChecks.organisationId, session.organisationId),
          ),
        )
        .orderBy(desc(schema.uptimeChecks.checkedAt))
        .limit(RECENT_CHECK_LIMIT)
    : [];

  const isResolved = incident.incident.status === "resolved";

  return (
    <>
      <PageHeader
        title={incident.incident.title}
        description={`${incident.siteName} — ${incident.siteUrl}`}
        category="support"
        actions={
          <>
            <form action={acknowledgeIncident}>
              <input type="hidden" name="incidentId" value={incident.incident.id} />
              <Button
                type="submit"
                variant="secondary"
                disabled={incident.incident.status !== "open"}
                className="max-sm:w-full"
              >
                Acknowledge
              </Button>
            </form>
            <form action={resolveIncident}>
              <input type="hidden" name="incidentId" value={incident.incident.id} />
              <Button type="submit" disabled={isResolved} className="max-sm:w-full">
                Resolve
              </Button>
            </form>
          </>
        }
      />

      <Section>
        <div className="rounded-xl border bg-card p-4">
          <KeyValue
            columns={2}
            items={[
              { label: "Status", value: <StatusBadge value={incident.incident.status} /> },
              { label: "Severity", value: <StatusBadge value={incident.incident.severity} /> },
              { label: "Opened", value: formatDateTime(incident.incident.openedAt) },
              { label: "Resolved", value: formatDateTime(incident.incident.resolvedAt) },
            ]}
          />
        </div>
      </Section>

      <Section title="Summary">
        {incident.incident.summaryMd ? (
          <div className="prose prose-sm max-w-none rounded-xl border bg-card p-4 [&_a]:underline [&_code]:text-xs [&_h1]:text-base [&_h2]:text-sm [&_li]:my-0.5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
            <Markdown>{incident.incident.summaryMd}</Markdown>
          </div>
        ) : (
          <EmptyState icon={FileText}>
            No summary yet. The Hosting Guard-Dog writes one when it triages the incident.
          </EmptyState>
        )}
      </Section>

      <Section title="Linked work">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border bg-card p-4">
            <p className="label-caps mb-2 text-muted-foreground">Linked ticket</p>
            {ticket ? (
              <div className="space-y-2 text-sm">
                <p className="font-medium">{ticket.subject}</p>
                <p className="flex flex-wrap gap-2">
                  <StatusBadge value={ticket.status} />
                  <StatusBadge value={ticket.severity} />
                </p>
                <p className="text-meta text-muted-foreground">Source: {ticket.source}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No ticket linked to this incident.</p>
            )}
          </div>

          <div className="rounded-xl border bg-card p-4">
            <p className="label-caps mb-2 text-muted-foreground">Agent run</p>
            {incident.incident.agentRunId ? (
              <Link
                href={`/agents/runs/${incident.incident.agentRunId}`}
                className="text-sm break-all text-primary underline underline-offset-2"
              >
                View run {incident.incident.agentRunId}
              </Link>
            ) : (
              <p className="text-sm text-muted-foreground">No agent has handled this incident.</p>
            )}
          </div>
        </div>
      </Section>

      <Section title={`Last ${RECENT_CHECK_LIMIT} uptime checks`}>
        <DataList
          rows={checks}
          columns={CHECK_COLUMNS}
          getRowKey={(check) => check.id}
          caption="Recent uptime checks"
          empty={<EmptyState icon={Activity}>No uptime checks recorded for this monitor.</EmptyState>}
        />
      </Section>
    </>
  );
}
