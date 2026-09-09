import { domainMetrics, listDomains } from "@launchos/core";
import {
  CalendarX,
  Globe2,
  Network,
  ShieldAlert,
  TimerReset,
} from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { FilterBar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/components/stat-card";
import { DomainExpiry } from "@/components/domain-expiry";
import { AvailabilityCheck } from "./availability-check";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

type DomainRow = Awaited<ReturnType<typeof listDomains>>[number];

const COLUMNS: readonly DataListColumn<DomainRow>[] = [
  {
    key: "name",
    header: "Domain",
    primary: true,
    cell: (row) => (
      <>
        <Link href={`/domains/${row.id}`} className="break-all hover:underline">
          {row.name}
        </Link>
        <span className="block text-meta font-normal text-muted-foreground">
          {row.registrar ?? "registrar unknown"}
        </span>
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
  {
    key: "site",
    header: "Website",
    cell: (row) =>
      row.siteId ? (
        <Link href={`/websites/${row.siteId}`} className="hover:underline">
          {row.siteName}
        </Link>
      ) : (
        "—"
      ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  { key: "dns", header: "DNS", hideOnMobile: true, cell: (row) => row.dnsProvider },
  { key: "expires", header: "Renews", className: "whitespace-nowrap", cell: (row) => <DomainExpiry expiresAt={row.expiresAt} /> },
];

export default async function DomainsPage({ searchParams }: PageProps<"/domains">) {
  const session = await requireAdmin();
  const metrics = await domainMetrics(getDb(), session.organisationId);
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  const rows = await listDomains(getDb(), session.organisationId, { query });

  return (
    <>
      <PageHeader
        wide
        title="Domains"
        description="Every domain bought for or assigned to a client."
        category="delivery"
      />

      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active"
          value={metrics.active}
          hint={"Registered and healthy"}
          category="overview"
          icon={Globe2}
        />
        <StatCard
          label="Expiring in 30 days"
          value={metrics.expiringSoon}
          hint={"Renewing soon"}
          category="delivery"
          icon={TimerReset}
          attention
          attentionTone="warning"
        />
        <StatCard
          label="Expired"
          value={metrics.expired}
          hint={"Past their renewal date"}
          category="support"
          icon={CalendarX}
          attention
        />
        <StatCard
          label="Auto-renew off"
          value={metrics.autoRenewOff}
          hint={"Expiring soon and not set to renew"}
          category="automation"
          icon={ShieldAlert}
          attention
          attentionTone="warning"
        />
      </div>

      <form action="/domains">
        <FilterBar>
          <ToolbarField label="Search domains" htmlFor="q" className="sm:w-72">
            <Input id="q" name="q" defaultValue={query ?? ""} placeholder="Domain or registrar" />
          </ToolbarField>
          <ToolbarActions>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
          </ToolbarActions>
        </FilterBar>
      </form>

      <div className="mb-6">
        <AvailabilityCheck />
      </div>

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Domains"
        empty={
          <EmptyState icon={Network}>
            No domains yet. Add one from a client&rsquo;s &ldquo;Sites &amp; Domains&rdquo; tab.
          </EmptyState>
        }
      />
    </>
  );
}
