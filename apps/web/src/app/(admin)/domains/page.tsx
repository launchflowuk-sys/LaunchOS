import { listDomains } from "@launchos/core";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DomainsPage({ searchParams }: PageProps<"/domains">) {
  const session = await requireAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  const rows = await listDomains(getDb(), session.organisationId, { query });

  return (
    <>
      <PageHeader title="Domains" description="Every domain bought for or assigned to a client." />

      <form className="mb-4" action="/domains">
        <label htmlFor="q" className="sr-only">
          Search domains
        </label>
        <input
          id="q"
          name="q"
          defaultValue={query ?? ""}
          placeholder="Domain or registrar"
          className="h-9 w-72 rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
        />
      </form>

      {rows.length === 0 ? (
        <EmptyState>No domains yet. Add one from a client&rsquo;s &ldquo;Sites &amp; Domains&rdquo; tab.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Website</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>DNS</TableHead>
                <TableHead>Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/domains/${row.id}`} className="font-medium text-neutral-900 hover:underline">
                      {row.name}
                    </Link>
                    <span className="block text-xs text-neutral-400">{row.registrar ?? "registrar unknown"}</span>
                  </TableCell>
                  <TableCell>
                    <Link href={`/clients/${row.clientId}`} className="text-neutral-700 hover:underline">
                      {row.clientName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-neutral-600">
                    {row.siteId ? (
                      <Link href={`/websites/${row.siteId}`} className="hover:underline">
                        {row.siteName}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.status} />
                  </TableCell>
                  <TableCell className="text-neutral-600">{row.dnsProvider}</TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(row.expiresAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
