import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

export default async function PortalDomainsPage() {
  const session = await requireClient();

  // Queried directly rather than through `listDomains`, which joins the client
  // and site tables to build the admin row. The portal shows neither, and both
  // halves of the scope — organisation and client — are on `domains` itself.
  const rows = await getDb()
    .select({
      id: schema.domains.id,
      name: schema.domains.name,
      registrar: schema.domains.registrar,
      expiresAt: schema.domains.expiresAt,
      autoRenew: schema.domains.autoRenew,
      status: schema.domains.status,
    })
    .from(schema.domains)
    .where(
      and(
        eq(schema.domains.organisationId, session.organisationId),
        eq(schema.domains.clientId, session.clientId),
      ),
    )
    .orderBy(asc(schema.domains.name));

  return (
    <>
      <PageHeader title="Domains" description="The domain names registered for you." />

      {rows.length === 0 ? (
        <EmptyState>No domains on your account yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Registrar</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Auto-renew</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium text-neutral-900">{row.name}</TableCell>
                  <TableCell className="text-neutral-600">{row.registrar ?? "—"}</TableCell>
                  <TableCell className="text-neutral-600">{formatDateTime(row.expiresAt)}</TableCell>
                  <TableCell className="text-neutral-600">{row.autoRenew ? "On" : "Off"}</TableCell>
                  <TableCell>
                    <StatusBadge value={row.status} />
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
