import { listClients, listPackages } from "@launchos/core";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { NewClientDialog } from "./new-client-dialog";

export const dynamic = "force-dynamic";

const STATUSES = ["all", "active", "paused", "archived"] as const;

export default async function ClientsPage({ searchParams }: PageProps<"/clients">) {
  const session = await requireAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  const statusParam = typeof params.status === "string" ? params.status : "active";
  const status = STATUSES.includes(statusParam as (typeof STATUSES)[number]) ? statusParam : "active";

  const [rows, packages] = await Promise.all([
    listClients(getDb(), session.organisationId, {
      query,
      status: status === "all" ? undefined : (status as "active" | "paused" | "archived"),
    }),
    listPackages(getDb(), session.organisationId, { activeOnly: true }),
  ]);

  return (
    <>
      <PageHeader
        title="Clients"
        description="Every client, their support address, websites and domains."
        actions={<NewClientDialog packages={packages.map((pkg) => ({ value: pkg.id, label: pkg.name }))} />}
      />

      <form className="mb-4 flex flex-wrap items-end gap-2" action="/clients">
        <div className="space-y-1.5">
          <label htmlFor="q" className="block text-xs font-medium text-neutral-500">
            Search
          </label>
          <input
            id="q"
            name="q"
            defaultValue={query ?? ""}
            placeholder="Name, slug or email"
            className="h-9 w-64 rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="status" className="block text-xs font-medium text-neutral-500">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={status}
            className="h-9 rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
          >
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value === "all" ? "All" : value}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="h-9 rounded-md border border-neutral-300 px-3 text-sm text-neutral-700 hover:bg-neutral-100">
          Apply
        </button>
      </form>

      {rows.length === 0 ? (
        <EmptyState>No clients match. Use “New client” to add the first one.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Support address</TableHead>
                <TableHead className="text-right">Websites</TableHead>
                <TableHead className="text-right">Domains</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/clients/${row.id}`} className="font-medium text-neutral-900 hover:underline">
                      {row.name}
                    </Link>
                    <span className="block text-xs text-neutral-400">{row.email ?? row.slug}</span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={row.status} />
                  </TableCell>
                  <TableCell className="text-neutral-600">{row.supportEmail ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-600">{row.siteCount}</TableCell>
                  <TableCell className="text-right tabular-nums text-neutral-600">{row.domainCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
