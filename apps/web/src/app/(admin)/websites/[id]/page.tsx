import {
  getClient,
  getSite,
  getSiteCmsCredentialStatus,
  isEncryptionConfigured,
  listDnsRecords,
  listDomains,
  siteReviewsStatus,
} from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import { Activity, KeyRound, Network, ShieldAlert, TableProperties } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { DataList, type DataListColumn } from "@/components/data-list";
import { KeyValue } from "@/components/key-value";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { SkeletonRows } from "@/components/skeleton-rows";
import { DeleteSiteSection } from "./delete-site-section";
import { SiteEmailSection } from "./email-section";
import { ReviewsPanel } from "./reviews-panel";
import { WordPressConnection } from "./wordpress-connection";

export const dynamic = "force-dynamic";

const INCIDENT_LIMIT = 10;

type DomainRow = Awaited<ReturnType<typeof listDomains>>[number];
type DnsRow = { id: string; domainName: string; type: string; name: string; value: string; ttl: number };
type MonitorRow = { id: string; target: string; intervalSeconds: number; consecutiveFailures: number };
type IncidentRow = { id: string; title: string; status: string; severity: string; openedAt: Date | null };

const DOMAIN_COLUMNS: readonly DataListColumn<DomainRow>[] = [
  {
    key: "name",
    header: "Domain",
    primary: true,
    cell: (row) => (
      <Link href={`/domains/${row.id}`} className="break-all hover:underline">
        {row.name}
      </Link>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  { key: "dns", header: "DNS", cell: (row) => row.dnsProvider },
  { key: "expires", header: "Expires", className: "whitespace-nowrap", cell: (row) => formatDateTime(row.expiresAt) },
];

const DNS_COLUMNS: readonly DataListColumn<DnsRow>[] = [
  { key: "type", header: "Type", primary: true, cell: (row) => row.type },
  { key: "domain", header: "Domain", cell: (row) => <span className="break-all">{row.domainName}</span> },
  { key: "name", header: "Name", cell: (row) => <span className="break-all">{row.name}</span> },
  { key: "value", header: "Value", className: "break-all", cell: (row) => row.value },
  { key: "ttl", header: "TTL", numeric: true, cell: (row) => row.ttl },
];

const MONITOR_COLUMNS: readonly DataListColumn<MonitorRow>[] = [
  { key: "target", header: "Target", primary: true, cell: (row) => <span className="break-all">{row.target}</span> },
  { key: "interval", header: "Every", numeric: true, cell: (row) => `${row.intervalSeconds}s` },
  {
    key: "failures",
    header: "Failures",
    numeric: true,
    cell: (row) =>
      row.consecutiveFailures > 0 ? (
        <span className="font-medium text-danger-fg">{row.consecutiveFailures}</span>
      ) : (
        row.consecutiveFailures
      ),
  },
];

const INCIDENT_COLUMNS: readonly DataListColumn<IncidentRow>[] = [
  {
    key: "title",
    header: "Incident",
    primary: true,
    cell: (row) => (
      <Link href={`/incidents/${row.id}`} className="hover:underline">
        {row.title}
      </Link>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  { key: "severity", header: "Severity", cell: (row) => <StatusBadge value={row.severity} /> },
  { key: "opened", header: "Opened", className: "whitespace-nowrap", cell: (row) => formatDateTime(row.openedAt) },
];

export default async function WebsiteDetailPage({ params }: PageProps<"/websites/[id]">) {
  const { id } = await params;
  const session = await requireAdmin();
  const db = getDb();

  const site = await getSite(db, session.organisationId, id);
  if (!site) notFound();

  const [client, domains, monitors, incidents, cmsCredential, reviews] = await Promise.all([
    getClient(db, session.organisationId, site.clientId),
    listDomains(db, session.organisationId, { siteId: site.id }),
    db
      .select()
      .from(schema.monitors)
      .where(and(eq(schema.monitors.organisationId, session.organisationId), eq(schema.monitors.siteId, site.id))),
    db
      .select({
        id: schema.incidents.id,
        title: schema.incidents.title,
        status: schema.incidents.status,
        severity: schema.incidents.severity,
        openedAt: schema.incidents.openedAt,
      })
      .from(schema.incidents)
      .where(and(eq(schema.incidents.organisationId, session.organisationId), eq(schema.incidents.siteId, site.id)))
      .orderBy(desc(schema.incidents.openedAt))
      .limit(INCIDENT_LIMIT),
    // Status only — the page never decrypts the stored application password.
    getSiteCmsCredentialStatus(db, session.organisationId, id),
    siteReviewsStatus(db, session.organisationId, id),
  ]);

  // One flat DNS table across every domain pointed at this site; editing lives
  // on the domain page, which owns the records.
  const dnsByDomain = await Promise.all(
    domains.map(async (domain) => ({
      domain,
      records: await listDnsRecords(db, session.organisationId, domain.id),
    })),
  );
  const dnsRows: DnsRow[] = dnsByDomain.flatMap((entry) =>
    entry.records.map((record) => ({
      id: record.id,
      domainName: entry.domain.name,
      type: record.type,
      name: record.name,
      value: record.value,
      ttl: record.ttl,
    })),
  );

  return (
    <>
      <PageHeader
        title={site.name}
        description={site.primaryUrl}
        category="delivery"
        actions={
          <div className="flex w-full flex-wrap items-center justify-between gap-3 sm:w-auto sm:justify-end">
            <StatusBadge value={site.status} />
            {client ? (
              <>
                {/* The client's vault: dashboard logins, the server it runs on, the database. */}
                <Button asChild variant="secondary">
                  <Link href={`/clients/${client.id}/access`}><KeyRound aria-hidden />Access details</Link>
                </Button>
                <Button asChild variant="secondary" className="max-w-full">
                  <Link href={`/clients/${client.id}`} className="min-w-0">
                    <span className="truncate">{client.name}</span>
                  </Link>
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      <Section title="Hosting">
        <div className="rounded-[20px] border bg-card p-5">
          <KeyValue
            columns={2}
            items={[
              { label: "Platform", value: site.platform },
              { label: "Hosting", value: site.hostingProvider },
              { label: "Hosting ref", value: site.hostingRef ?? "—" },
              { label: "Primary URL", value: <span className="break-all">{site.primaryUrl}</span> },
            ]}
          />
        </div>
      </Section>

      <Section
        title="WordPress connection"
        description="The application password LaunchOS uses to publish approved content changes to this site."
      >
        <WordPressConnection
          siteId={site.id}
          platform={site.platform}
          encryptionConfigured={isEncryptionConfigured(process.env)}
          connectedAs={cmsCredential?.username ?? null}
          connectedAt={cmsCredential?.updatedAt ?? null}
        />
      </Section>

      {/* After the WordPress connection because both are "what this site is
          wired to", and before Domains because a client asks about their
          reviews far more often than about a DNS record. */}
      <Section
        title="Google reviews"
        description="This site can show its Google reviews without holding a Google key — we read the listing every morning and serve it on a public URL the site fetches."
      >
        <ReviewsPanel site={site} stored={reviews} />
      </Section>

      {/* Streamed: Hostinger answers in its own time and the rest of the
          page should not wait for it. */}
      <Section
        title="Email"
        description="Hostinger mailboxes on this website's domains — how full each one is and what the plan costs."
      >
        <Suspense fallback={<SkeletonRows rows={3} />}>
          <SiteEmailSection organisationId={session.organisationId} siteId={site.id} />
        </Suspense>
      </Section>

      <Section title="Domains" description="Every domain pointed at this website.">
        <DataList
          rows={domains}
          columns={DOMAIN_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Domains"
          empty={<EmptyState icon={Network}>No domain points at this website yet.</EmptyState>}
        />
      </Section>

      <Section title="DNS records" description="What DNS should say. Editing lives on the domain page.">
        <DataList
          rows={dnsRows}
          columns={DNS_COLUMNS}
          getRowKey={(row) => row.id}
          caption="DNS records"
          empty={<EmptyState icon={TableProperties}>No DNS records recorded. Add them on the domain page.</EmptyState>}
        />
      </Section>

      <Section title="Monitors" description="What watches this site, and how often.">
        <DataList
          rows={monitors}
          columns={MONITOR_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Monitors"
          empty={<EmptyState icon={Activity}>No monitor watches this site.</EmptyState>}
        />
      </Section>

      <Section title="Recent incidents">
        <DataList
          rows={incidents}
          columns={INCIDENT_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Recent incidents"
          empty={<EmptyState icon={ShieldAlert}>No incidents recorded.</EmptyState>}
        />
      </Section>

      {/* Last on the page, like the client delete: a destructive action belongs
          where somebody scrolls to it deliberately, not beside the edit form. */}
      <Section
        title="Delete this website"
        description="Removes the record for good. Refused while a monitor, domain, incident or support case depends on it — so a duplicate row can go and a real one cannot."
      >
        <DeleteSiteSection siteId={site.id} />
      </Section>
    </>
  );
}
