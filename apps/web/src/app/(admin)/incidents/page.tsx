import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function IncidentsPage() {
  const session = await requireAdmin();

  const rows = await getDb()
    .select({
      id: schema.incidents.id,
      title: schema.incidents.title,
      status: schema.incidents.status,
      severity: schema.incidents.severity,
      openedAt: schema.incidents.openedAt,
      siteName: schema.sites.name,
      siteUrl: schema.sites.primaryUrl,
    })
    .from(schema.incidents)
    .innerJoin(schema.sites, eq(schema.incidents.siteId, schema.sites.id))
    .where(eq(schema.incidents.organisationId, session.organisationId))
    .orderBy(desc(schema.incidents.openedAt));

  return (
    <>
      <PageHeader title="Incidents" description="Uptime and hosting incidents across every client site." />

      {rows.length === 0 ? (
        <EmptyState>No incidents. Every monitored site is healthy.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Incident</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Opened</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/incidents/${row.id}`} className="font-medium text-neutral-900 hover:underline">
                      {row.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.status} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.severity} />
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    <span className="block">{row.siteName}</span>
                    <span className="block text-xs text-neutral-400">{row.siteUrl}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(row.openedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
