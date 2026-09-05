import { listClients, listPackages } from "@launchos/core";
import { Building2 } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PAGE_SIZE, Pager, pageParam } from "@/components/pager";
import { StatusBadge } from "@/components/status-badge";
import { FilterBar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { NewClientDialog } from "./new-client-dialog";

export const dynamic = "force-dynamic";

const STATUSES = ["all", "active", "paused", "archived"] as const;

type ClientRow = Awaited<ReturnType<typeof listClients>>[number];

const COLUMNS: readonly DataListColumn<ClientRow>[] = [
  {
    key: "name",
    header: "Client",
    primary: true,
    cell: (row) => (
      <>
        <Link href={`/clients/${row.id}`} className="hover:underline">
          {row.name}
        </Link>
        <span className="block text-meta font-normal text-muted-foreground">{row.email ?? row.slug}</span>
      </>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  {
    key: "supportEmail",
    header: "Support address",
    className: "break-all",
    cell: (row) => row.supportEmail ?? "—",
  },
  { key: "sites", header: "Websites", numeric: true, cell: (row) => row.siteCount },
  { key: "domains", header: "Domains", numeric: true, cell: (row) => row.domainCount },
];

export default async function ClientsPage({ searchParams }: PageProps<"/clients">) {
  const session = await requireAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  const statusParam = typeof params.status === "string" ? params.status : "active";
  const status = STATUSES.includes(statusParam as (typeof STATUSES)[number]) ? statusParam : "active";
  const page = pageParam(params.page);

  // One screenful at a time: the roster grows without bound and under `md` a
  // DataList renders a card per row, so an unpaged list is a phone scrolling
  // past every client the agency has ever had.
  const [fetched, packages] = await Promise.all([
    listClients(getDb(), session.organisationId, {
      query,
      status: status === "all" ? undefined : (status as "active" | "paused" | "archived"),
      limit: PAGE_SIZE + 1,
      offset: (page - 1) * PAGE_SIZE,
      // Newest first: a client added a moment ago is on page 1 rather than
      // wherever the alphabet puts them.
      order: "recent",
    }),
    listPackages(getDb(), session.organisationId, { activeOnly: true }),
  ]);

  const hasNext = fetched.length > PAGE_SIZE;
  const rows = hasNext ? fetched.slice(0, PAGE_SIZE) : fetched;

  return (
    <>
      <PageHeader
        title="Clients"
        description="Every client, their support address, websites and domains."
        category="delivery"
        actions={<NewClientDialog packages={packages.map((pkg) => ({ value: pkg.id, label: pkg.name }))} />}
      />

      <form action="/clients">
        <FilterBar>
          <ToolbarField label="Search" htmlFor="q" className="sm:w-64">
            <Input id="q" name="q" defaultValue={query ?? ""} placeholder="Name, slug or email" />
          </ToolbarField>
          <ToolbarField label="Status" htmlFor="status" className="sm:w-40">
            <NativeSelect id="status" name="status" defaultValue={status}>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All" : value}
                </option>
              ))}
            </NativeSelect>
          </ToolbarField>
          <ToolbarActions>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
          </ToolbarActions>
        </FilterBar>
      </form>

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Clients"
        empty={
          <EmptyState icon={Building2}>
            {page > 1
              ? "There are no clients on this page. Go back to a newer page."
              : "No clients match. Use “New client” to add the first one."}
          </EmptyState>
        }
      />
      {/* Outside the empty check on purpose: a page past the end has no rows
          and still needs the "Newer" link back. */}
      <Pager basePath="/clients" query={{ q: query, status }} page={page} hasNext={hasNext} />
    </>
  );
}
