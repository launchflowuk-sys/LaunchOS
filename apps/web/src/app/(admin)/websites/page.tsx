import { listSites } from "@launchos/core";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function WebsitesPage({ searchParams }: PageProps<"/websites">) {
  const session = await requireAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  const rows = await listSites(getDb(), session.organisationId, { query });

  return (
    <>
      <PageHeader title="Websites" description="Every site we build, host or look after." />

      <form className="mb-4" action="/websites">
        <label htmlFor="q" className="sr-only">
          Search websites
        </label>
        <input
          id="q"
          name="q"
          defaultValue={query ?? ""}
          placeholder="Name or URL"
          className="h-9 w-72 rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
        />
      </form>

      {rows.length === 0 ? (
        <EmptyState>No websites yet. Add one from a client&rsquo;s &ldquo;Sites &amp; Domains&rdquo; tab.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Website</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead className="text-right">Domains</TableHead>
                <TableHead className="text-right">Open incidents</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/websites/${row.id}`} className="font-medium text-neutral-900 hover:underline">
                      {row.name}
                    </Link>
                    <span className="block text-xs text-neutral-400">{row.primaryUrl}</span>
                  </TableCell>
                  <TableCell>
                    <Link href={`/clients/${row.clientId}`} className="text-neutral-700 hover:underline">
                      {row.clientName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.status} />
                  </TableCell>
                  <TableCell className="text-neutral-600">{row.platform}</TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-600">{row.domainCount}</TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-600">{row.openIncidentCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
