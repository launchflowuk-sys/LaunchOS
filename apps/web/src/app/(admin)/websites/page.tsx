import { listSites } from "@launchos/core";
import { Globe } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { FilterBar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

type SiteRow = Awaited<ReturnType<typeof listSites>>[number];

const COLUMNS: readonly DataListColumn<SiteRow>[] = [
  {
    key: "name",
    header: "Website",
    primary: true,
    cell: (row) => (
      <>
        <Link href={`/websites/${row.id}`} className="hover:underline">
          {row.name}
        </Link>
        <span className="block text-meta font-normal break-all text-muted-foreground">{row.primaryUrl}</span>
      </>
    ),
  },
  {
    key: "client",
    header: "Client",
    cell: (row) => (
      <Link href={`/clients/${row.clientId}`} className="hover:underline">
        {row.clientName}
      </Link>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  { key: "platform", header: "Platform", hideOnMobile: true, cell: (row) => row.platform },
  { key: "domains", header: "Domains", numeric: true, cell: (row) => row.domainCount },
  {
    key: "incidents",
    header: "Open incidents",
    numeric: true,
    cell: (row) =>
      row.openIncidentCount > 0 ? (
        <span className="font-medium text-danger-fg">{row.openIncidentCount}</span>
      ) : (
        row.openIncidentCount
      ),
  },
];

export default async function WebsitesPage({ searchParams }: PageProps<"/websites">) {
  const session = await requireAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  const rows = await listSites(getDb(), session.organisationId, { query });

  return (
    <>
      <PageHeader title="Websites" description="Every site we build, host or look after." category="delivery" />

      <form action="/websites">
        <FilterBar>
          <ToolbarField label="Search websites" htmlFor="q" className="sm:w-72">
            <Input id="q" name="q" defaultValue={query ?? ""} placeholder="Name or URL" />
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
        caption="Websites"
        empty={
          <EmptyState icon={Globe}>
            No websites yet. Add one from a client&rsquo;s &ldquo;Sites &amp; Domains&rdquo; tab.
          </EmptyState>
        }
      />
    </>
  );
}
