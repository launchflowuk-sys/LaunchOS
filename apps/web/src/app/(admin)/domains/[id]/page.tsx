import { getClient, getDomain, listDnsRecords, listSites } from "@launchos/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { AttachSiteForm } from "./attach-site-form";
import { AddDnsRecordForm } from "./dns-form";
import { DeleteDnsRecordButton } from "./delete-dns-record-button";

export const dynamic = "force-dynamic";

export default async function DomainDetailPage({ params }: PageProps<"/domains/[id]">) {
  const { id } = await params;
  const session = await requireAdmin();
  const db = getDb();

  const domain = await getDomain(db, session.organisationId, id);
  if (!domain) notFound();

  const [client, sites, records] = await Promise.all([
    getClient(db, session.organisationId, domain.clientId),
    listSites(db, session.organisationId, { clientId: domain.clientId }),
    listDnsRecords(db, session.organisationId, domain.id),
  ]);

  return (
    <>
      <PageHeader
        title={domain.name}
        // exactOptionalPropertyTypes forbids passing `description={undefined}` since
        // the prop type is `string` (not `string | undefined`); spread it in only
        // when there is a client to describe.
        {...(client ? { description: `${client.name} · ${domain.registrar ?? "registrar unknown"}` } : {})}
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
            <StatusBadge value={domain.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">DNS provider</dt>
          <dd className="mt-1 text-neutral-700">{domain.dnsProvider}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Expires</dt>
          <dd className="mt-1 text-neutral-700">{formatDateTime(domain.expiresAt)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Nameservers</dt>
          <dd className="mt-1 text-neutral-700">{domain.nameservers.length > 0 ? domain.nameservers.join(", ") : "—"}</dd>
        </div>
      </dl>

      <section className="mb-6 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">Website</h2>
        <AttachSiteForm domainId={domain.id} siteId={domain.siteId} sites={sites} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">DNS records</h2>
        <div className="mb-4 rounded-lg border border-neutral-200 bg-white p-4">
          <AddDnsRecordForm domainId={domain.id} />
          <p className="mt-3 text-xs text-neutral-400">
            This records what DNS should say. Pushing changes to a provider is an approval-gated agent action from Plan 4.
          </p>
        </div>
        {records.length === 0 ? (
          <EmptyState>No DNS records recorded for this domain.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead className="text-right">TTL</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="font-medium text-neutral-900">{record.type}</TableCell>
                    <TableCell className="text-neutral-600">{record.name}</TableCell>
                    <TableCell className="max-w-md truncate text-neutral-600">{record.value}</TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-600">{record.ttl}</TableCell>
                    <TableCell className="text-right">
                      <DeleteDnsRecordButton recordId={record.id} domainId={domain.id} />
                    </TableCell>
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
