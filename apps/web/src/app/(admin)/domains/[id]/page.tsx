import { getClient, getDomain, listDnsRecords, listSites } from "@launchos/core";
import { TableProperties } from "lucide-react";
import Link from "next/link";
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
import { AttachSiteForm } from "./attach-site-form";
import { AddDnsRecordForm } from "./dns-form";
import { DeleteDnsRecordButton } from "./delete-dns-record-button";

export const dynamic = "force-dynamic";

type DnsRecord = Awaited<ReturnType<typeof listDnsRecords>>[number];

function dnsColumns(domainId: string): readonly DataListColumn<DnsRecord>[] {
  return [
    { key: "type", header: "Type", primary: true, cell: (record) => record.type },
    { key: "name", header: "Name", cell: (record) => <span className="break-all">{record.name}</span> },
    { key: "value", header: "Value", className: "break-all", cell: (record) => record.value },
    { key: "ttl", header: "TTL", numeric: true, cell: (record) => record.ttl },
    {
      key: "remove",
      header: "Remove",
      action: true,
      cell: (record) => <DeleteDnsRecordButton recordId={record.id} domainId={domainId} />,
    },
  ];
}

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
        category="delivery"
        actions={
          <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
            <StatusBadge value={domain.status} />
            {client ? (
              <Button asChild variant="secondary">
                <Link href={`/clients/${client.id}`}>{client.name}</Link>
              </Button>
            ) : null}
          </div>
        }
      />

      <Section title="Registration">
        <div className="rounded-xl border bg-card p-4">
          <KeyValue
            columns={2}
            items={[
              { label: "DNS provider", value: domain.dnsProvider },
              { label: "Registrar", value: domain.registrar ?? "—" },
              { label: "Expires", value: formatDateTime(domain.expiresAt) },
              {
                label: "Nameservers",
                value: domain.nameservers.length > 0 ? domain.nameservers.join(", ") : "—",
              },
            ]}
          />
        </div>
      </Section>

      <Section title="Website" description="Which of this client's websites the domain points at.">
        <div className="rounded-xl border bg-card p-4">
          <AttachSiteForm domainId={domain.id} siteId={domain.siteId} sites={sites} />
        </div>
      </Section>

      <Section
        title="DNS records"
        description="This records what DNS should say. Pushing changes to a provider is an approval-gated agent action."
      >
        <div className="mb-4 rounded-xl border bg-card p-4">
          <AddDnsRecordForm domainId={domain.id} />
        </div>
        <DataList
          rows={records}
          columns={dnsColumns(domain.id)}
          getRowKey={(record) => record.id}
          caption="DNS records"
          empty={<EmptyState icon={TableProperties}>No DNS records recorded for this domain.</EmptyState>}
        />
      </Section>
    </>
  );
}
