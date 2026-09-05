import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { acknowledgeIncident, resolveIncident } from "./actions";

export const dynamic = "force-dynamic";

const RECENT_CHECK_LIMIT = 20;

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
        actions={
          <div className="flex gap-2">
            <form action={acknowledgeIncident}>
              <input type="hidden" name="incidentId" value={incident.incident.id} />
              <Button type="submit" variant="secondary" disabled={incident.incident.status !== "open"}>
                Acknowledge
              </Button>
            </form>
            <form action={resolveIncident}>
              <input type="hidden" name="incidentId" value={incident.incident.id} />
              <Button type="submit" disabled={isResolved}>
                Resolve
              </Button>
            </form>
          </div>
        }
      />

      <dl className="mb-6 grid grid-cols-2 gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Status</dt>
          <dd className="mt-1">
            <StatusBadge value={incident.incident.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Severity</dt>
          <dd className="mt-1">
            <StatusBadge value={incident.incident.severity} />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Opened</dt>
          <dd className="mt-1 text-neutral-700">{formatDateTime(incident.incident.openedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Resolved</dt>
          <dd className="mt-1 text-neutral-700">{formatDateTime(incident.incident.resolvedAt)}</dd>
        </div>
      </dl>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">Summary</h2>
        {incident.incident.summaryMd ? (
          <div className="prose prose-sm prose-neutral max-w-none rounded-lg border border-neutral-200 bg-white p-4 [&_a]:underline [&_code]:text-xs [&_h1]:text-base [&_h2]:text-sm [&_li]:my-0.5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
            <Markdown>{incident.incident.summaryMd}</Markdown>
          </div>
        ) : (
          <EmptyState>No summary yet. The Hosting Guard-Dog writes one when it triages the incident.</EmptyState>
        )}
      </section>

      <section className="mb-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-neutral-900">Linked ticket</h2>
          {ticket ? (
            <div className="text-sm text-neutral-700">
              <p className="font-medium text-neutral-900">{ticket.subject}</p>
              <p className="mt-1 flex gap-2">
                <StatusBadge value={ticket.status} />
                <StatusBadge value={ticket.severity} />
              </p>
              <p className="mt-2 text-xs text-neutral-500">Source: {ticket.source}</p>
            </div>
          ) : (
            <p className="text-sm text-neutral-500">No ticket linked to this incident.</p>
          )}
        </div>

        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-neutral-900">Agent run</h2>
          {incident.incident.agentRunId ? (
            <Link href={`/agents/runs/${incident.incident.agentRunId}`} className="text-sm text-neutral-900 underline">
              View run {incident.incident.agentRunId}
            </Link>
          ) : (
            <p className="text-sm text-neutral-500">No agent has handled this incident.</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">
          Last {RECENT_CHECK_LIMIT} uptime checks
        </h2>
        {checks.length === 0 ? (
          <EmptyState>No uptime checks recorded for this monitor.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Checked</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Status code</TableHead>
                  <TableHead>Latency</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {checks.map((check) => (
                  <TableRow key={check.id}>
                    <TableCell className="whitespace-nowrap text-neutral-600">
                      {formatDateTime(check.checkedAt)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={check.ok ? "up" : "down"} tone={check.ok ? "success" : "danger"} />
                    </TableCell>
                    <TableCell className="tabular-nums text-neutral-600">{check.statusCode ?? "—"}</TableCell>
                    <TableCell className="tabular-nums text-neutral-600">
                      {check.latencyMs === null ? "—" : `${check.latencyMs} ms`}
                    </TableCell>
                    <TableCell className="text-neutral-600">{check.error ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </>
  );
}
