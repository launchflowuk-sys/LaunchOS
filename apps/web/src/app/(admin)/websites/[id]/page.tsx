import { getClient, getSite, listDnsRecords, listDomains } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const INCIDENT_LIMIT = 10;

export default async function WebsiteDetailPage({ params }: PageProps<"/websites/[id]">) {
  const { id } = await params;
  const session = await requireAdmin();
  const db = getDb();

  const site = await getSite(db, session.organisationId, id);
  if (!site) notFound();

  const [client, domains, monitors, incidents] = await Promise.all([
    getClient(db, session.organisationId, site.clientId),
    listDomains(db, session.organisationId, { siteId: site.id }),
    db
      .select()
      .from(schema.monitors)
      .where(and(eq(schema.monitors.organisationId, session.organisationId), eq(schema.monitors.siteId, site.id))),
    db
      .select({
        id: schema.incidents.id,
        title: schema.incidents.title,
        status: schema.incidents.status,
        severity: schema.incidents.severity,
        openedAt: schema.incidents.openedAt,
      })
      .from(schema.incidents)
      .where(and(eq(schema.incidents.organisationId, session.organisationId), eq(schema.incidents.siteId, site.id)))
      .orderBy(desc(schema.incidents.openedAt))
      .limit(INCIDENT_LIMIT),
  ]);

  // One flat DNS table across every domain pointed at this site; editing lives
  // on the domain page, which owns the records.
  const dnsByDomain = await Promise.all(
    domains.map(async (domain) => ({
      domain,
      records: await listDnsRecords(db, session.organisationId, domain.id),
    })),
  );

  return (
    <>
      <PageHeader
        title={site.name}
        description={site.primaryUrl}
        actions={
          client ? (
            <Link href={`/clients/${client.id}`} className="text-sm text-neutral-700 underline">
              {client.name}
            </Link>
          ) : null
        }
      />

      <dl className="mb-6 grid grid-cols-2 gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Status</dt>
          <dd className="mt-1">
            <StatusBadge value={site.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Platform</dt>
          <dd className="mt-1 text-neutral-700">{site.platform}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Hosting</dt>
          <dd className="mt-1 text-neutral-700">{site.hostingProvider}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Hosting ref</dt>
          <dd className="mt-1 truncate text-neutral-700">{site.hostingRef ?? "—"}</dd>
        </div>
      </dl>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">Domains</h2>
        {domains.length === 0 ? (
          <EmptyState>No domain points at this website yet.</EmptyState>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {domains.map((domain) => (
              <li key={domain.id}>
                <Link
                  href={`/domains/${domain.id}`}
                  className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-800 hover:border-neutral-300"
                >
                  {domain.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">DNS records</h2>
        {dnsByDomain.every((entry) => entry.records.length === 0) ? (
          <EmptyState>No DNS records recorded. Add them on the domain page.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead className="text-right">TTL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dnsByDomain.flatMap((entry) =>
                  entry.records.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell className="text-neutral-600">{entry.domain.name}</TableCell>
                      <TableCell className="font-medium text-neutral-900">{record.type}</TableCell>
                      <TableCell className="text-neutral-600">{record.name}</TableCell>
                      <TableCell className="max-w-xs truncate text-neutral-600">{record.value}</TableCell>
                      <TableCell className="text-right tabular-nums text-neutral-600">{record.ttl}</TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-neutral-900">Monitors</h2>
          {monitors.length === 0 ? (
            <p className="text-sm text-neutral-500">No monitor watches this site.</p>
          ) : (
            <ul className="space-y-1 text-sm text-neutral-700">
              {monitors.map((monitor) => (
                <li key={monitor.id} className="flex justify-between gap-2">
                  <span className="truncate">{monitor.target}</span>
                  <span className="shrink-0 text-xs text-neutral-400">
                    every {monitor.intervalSeconds}s · {monitor.consecutiveFailures} failures
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-neutral-900">Recent incidents</h2>
          {incidents.length === 0 ? (
            <p className="text-sm text-neutral-500">No incidents recorded.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {incidents.map((incident) => (
                <li key={incident.id} className="flex items-center justify-between gap-2">
                  <Link href={`/incidents/${incident.id}`} className="truncate text-neutral-800 hover:underline">
                    {incident.title}
                  </Link>
                  <span className="flex shrink-0 items-center gap-1">
                    <StatusBadge value={incident.status} />
                    <span className="text-xs text-neutral-400">{formatDateTime(incident.openedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}
