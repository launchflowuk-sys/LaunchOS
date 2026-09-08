import {
  listSites,
  siteThumbnails,
  websiteMetrics,
  type SiteThumbnail,
} from "@launchos/core";
import { Globe, Hammer, Rocket, Siren } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { FilterBar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/components/stat-card";
import { getDb } from "@/lib/db";
import { SiteGrid } from "./site-grid";
import { SiteThumb } from "./site-thumb";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

type SiteRow = Awaited<ReturnType<typeof listSites>>[number];

/**
 * Built per request rather than declared once, because the first column now
 * carries a picture and which picture depends on a map fetched for this page.
 */
function columnsFor(
  thumbnails: Map<string, SiteThumbnail>,
): readonly DataListColumn<SiteRow>[] {
  return [
    {
      key: "name",
      header: "Website",
      primary: true,
      cell: (row) => (
        <div className="flex min-w-0 items-center gap-3">
          <SiteThumb
            siteId={row.id}
            name={row.name}
            thumbnail={thumbnails.get(row.id)}
            className="hidden w-20 shrink-0 rounded-[10px] sm:flex"
          />
          <div className="min-w-0">
            <Link href={`/websites/${row.id}`} className="hover:underline">
              {row.name}
            </Link>
            <span className="block text-meta font-normal break-all text-muted-foreground">
              {row.primaryUrl}
            </span>
          </div>
        </div>
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
    {
      key: "status",
      header: "Status",
      status: true,
      cell: (row) => <StatusBadge value={row.status} />,
    },
    {
      key: "platform",
      header: "Platform",
      hideOnMobile: true,
      cell: (row) => row.platform,
    },
    {
      key: "domains",
      header: "Domains",
      numeric: true,
      cell: (row) => row.domainCount,
    },
    {
      key: "incidents",
      header: "Open incidents",
      numeric: true,
      cell: (row) =>
        row.openIncidentCount > 0 ? (
          <span className="font-medium text-danger-fg">
            {row.openIncidentCount}
          </span>
        ) : (
          row.openIncidentCount
        ),
    },
  ];
}

export default async function WebsitesPage({
  searchParams,
}: PageProps<"/websites">) {
  const session = await requireAdmin();
  const metrics = await websiteMetrics(getDb(), session.organisationId);
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  // The grid is what the thumbnails are for; the list stays the default
  // because it is the better tool for comparing a column.
  const view =
    typeof params.view === "string" && params.view === "grid" ? "grid" : "list";
  const rows = await listSites(getDb(), session.organisationId, { query });
  // One query for the whole page, keyed by site. Deliberately without the
  // bytes — each `<img>` fetches its own from /api/websites/[id]/thumbnail.
  const thumbnails = await siteThumbnails(
    getDb(),
    session.organisationId,
    rows.map((row) => row.id),
  );

  return (
    <>
      <PageHeader
        title="Websites"
        description="Every site we build, host or look after."
        category="delivery"
        actions={
          <Button asChild variant="secondary">
            <Link
              href={{
                pathname: "/websites",
                query: { ...params, view: view === "grid" ? "list" : "grid" },
              }}
            >
              {view === "grid" ? "List view" : "Grid view"}
            </Link>
          </Button>
        }
      />

      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Live"
          value={metrics.live}
          hint={"Serving traffic"}
          category="overview"
          icon={Globe}
        />
        <StatCard
          label="In build"
          value={metrics.building}
          hint={"Not launched yet"}
          category="delivery"
          icon={Hammer}
        />
        <StatCard
          label="Needs attention"
          value={metrics.withOpenIncident}
          hint={"Sites with an open incident"}
          href="/incidents"
          category="support"
          icon={Siren}
          attention
        />
        <StatCard
          label="Launched this month"
          value={metrics.launchedThisMonth}
          hint={"Added since the 1st"}
          category="money"
          icon={Rocket}
        />
      </div>

      <form action="/websites">
        <FilterBar>
          <ToolbarField label="Search websites" htmlFor="q" className="sm:w-72">
            <Input
              id="q"
              name="q"
              defaultValue={query ?? ""}
              placeholder="Name or URL"
            />
          </ToolbarField>
          <ToolbarActions>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
          </ToolbarActions>
        </FilterBar>
      </form>

      {view === "grid" && rows.length > 0 ? (
        <SiteGrid sites={rows} thumbnails={thumbnails} />
      ) : (
        <DataList
          rows={rows}
          columns={columnsFor(thumbnails)}
          getRowKey={(row) => row.id}
          caption="Websites"
          empty={
            <EmptyState icon={Globe}>
              No websites yet. Add one from a client&rsquo;s &ldquo;Sites &amp;
              Domains&rdquo; tab.
            </EmptyState>
          }
        />
      )}
    </>
  );
}
