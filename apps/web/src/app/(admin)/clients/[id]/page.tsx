import { getBillingProfile, getClient, listActivity, listContacts, listDomains, listSites } from "@launchos/core";
import { Activity, Globe, Network, Users } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { isInAppPath } from "@/lib/in-app-path";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { MeetingsStrip } from "../../meetings/meetings-strip";
import { SubscriptionsSection } from "./billing/subscriptions-section";
import { ClientDetailsForm } from "./client-details-form";
import {
  AddContactForm, AddDomainForm, AddSiteForm, ArchiveClientButton, BillingForm, RemoveContactButton,
} from "./forms";
import { CLIENT_TABS, ClientTabs, type ClientTabKey } from "./tabs";

export const dynamic = "force-dynamic";

type Contact = Awaited<ReturnType<typeof listContacts>>[number];
type Site = Awaited<ReturnType<typeof listSites>>[number];
type Domain = Awaited<ReturnType<typeof listDomains>>[number];

export default async function ClientDetailPage({ params, searchParams }: PageProps<"/clients/[id]">) {
  const id = uuidOr404((await params).id);
  const query = await searchParams;
  const session = await requireAdmin();
  const db = getDb();

  const client = await getClient(db, session.organisationId, id);
  if (!client) notFound();

  const requested = typeof query.tab === "string" ? query.tab : "overview";
  const tab: ClientTabKey = CLIENT_TABS.some((t) => t.key === requested) ? (requested as ClientTabKey) : "overview";

  return (
    <>
      <PageHeader
        title={client.name}
        description={`${client.supportEmail ?? "no support address"} · ${[client.city, client.postcode].filter(Boolean).join(" ") || "no address"}`}
        category="delivery"
        actions={
          <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
            <StatusBadge value={client.status} />
            <ArchiveClientButton clientId={client.id} disabled={client.status === "archived"} />
          </div>
        }
      />

      <ClientTabs clientId={client.id} active={tab} />

      {tab === "overview" ? <OverviewTab client={client} /> : null}
      {tab === "contacts" ? <ContactsTab clientId={client.id} /> : null}
      {tab === "sites" ? <SitesTab clientId={client.id} /> : null}
    </>
  );
}

type ClientRecord = NonNullable<Awaited<ReturnType<typeof getClient>>>;

/**
 * The details editor, the calls booked with them, then the timeline. The
 * timeline is a list rather than a `DataList`: these are events in order,
 * not rows to compare, and every entry is one sentence with a time beside it.
 */
async function OverviewTab({ client }: { client: ClientRecord }) {
  const session = await requireAdmin();
  const events = await listActivity(getDb(), session.organisationId, { clientId: client.id });

  return (
    <>
    <Section title="Details" description="The name on their record, and how we reach them. Support mail keeps routing to the same address.">
      <div className="rounded-xl border bg-card p-4">
        <ClientDetailsForm
          clientId={client.id}
          defaults={{
            name: client.name,
            tradingName: client.tradingName ?? "",
            email: client.email ?? "",
            phone: client.phone ?? "",
            websiteUrl: client.websiteUrl ?? "",
            industry: client.industry ?? "",
            addressLine1: client.addressLine1 ?? "",
            addressLine2: client.addressLine2 ?? "",
            city: client.city ?? "",
            postcode: client.postcode ?? "",
            notes: client.notes ?? "",
          }}
        />
      </div>
    </Section>

    <MeetingsStrip organisationId={session.organisationId} clientId={client.id} />

    <Section title="Activity" description="Everything that has happened for this client, newest first.">
      {events.length === 0 ? (
        <EmptyState icon={Activity}>Nothing has happened yet. Add a contact, a domain or a website.</EmptyState>
      ) : (
        <ol className="grid gap-3">
          {events.map((event) => (
            <li key={event.id} className="rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 text-sm font-medium break-words">
                  {/* `activity_events.link` is free text a service or an agent
                      wrote, so it is guarded exactly like `notifications.link`:
                      anything that is not unambiguously a path inside this app —
                      a protocol-relative `//host`, a scheme, a backslash — renders
                      as plain text rather than as a link off the timeline. */}
                  {isInAppPath(event.link) ? (
                    <Link href={event.link} className="hover:underline">
                      {event.title}
                    </Link>
                  ) : (
                    event.title
                  )}
                </p>
                <p className="shrink-0 text-meta text-muted-foreground">
                  {formatDateTime(event.createdAt)} · {event.actorKind}
                </p>
              </div>
              {event.body ? <p className="mt-1 text-sm break-words text-muted-foreground">{event.body}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </Section>
    </>
  );
}

const CONTACT_COLUMNS: readonly DataListColumn<Contact & { clientId: string }>[] = [
  {
    key: "name",
    header: "Name",
    primary: true,
    cell: (row) => (
      <span className="inline-flex flex-wrap items-center gap-2">
        {row.name}
        {row.isPrimary ? <StatusBadge value="primary" tone="info" /> : null}
      </span>
    ),
  },
  { key: "email", header: "Email", cell: (row) => row.email ?? "—" },
  { key: "phone", header: "Phone", cell: (row) => row.phone ?? "—" },
  { key: "role", header: "Role", cell: (row) => row.role ?? "—" },
  {
    key: "remove",
    header: "Remove",
    action: true,
    cell: (row) => <RemoveContactButton clientId={row.clientId} contactId={row.id} />,
  },
];

async function ContactsTab({ clientId }: { clientId: string }) {
  const session = await requireAdmin();
  const db = getDb();
  const [contacts, billing] = await Promise.all([
    listContacts(db, session.organisationId, clientId),
    getBillingProfile(db, session.organisationId, clientId),
  ]);

  return (
    <>
      <Section title="Contacts" description="Who we talk to. The primary contact receives the invoices.">
        <div className="mb-4 rounded-xl border bg-card p-4">
          <AddContactForm clientId={clientId} />
        </div>
        <DataList
          rows={contacts.map((contact) => ({ ...contact, clientId }))}
          columns={CONTACT_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Contacts"
          empty={<EmptyState icon={Users}>No contacts yet. Add the first one above.</EmptyState>}
        />
      </Section>

      <Section title="Billing" description="Card and bank numbers are never stored. Payment methods live with Stripe.">
        <div className="rounded-xl border bg-card p-4">
          <BillingForm
            clientId={clientId}
            defaults={{
              billingName: billing?.billingName ?? "",
              addressLine1: billing?.addressLine1 ?? "",
              city: billing?.city ?? "",
              postcode: billing?.postcode ?? "",
              vatNumber: billing?.vatNumber ?? "",
              paymentTermsDays: billing?.paymentTermsDays ?? 14,
              preferredMethod: billing?.preferredMethod ?? "",
            }}
          />
        </div>
      </Section>

      <SubscriptionsSection clientId={clientId} />
    </>
  );
}

const SITE_COLUMNS: readonly DataListColumn<Site>[] = [
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
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  { key: "platform", header: "Platform", cell: (row) => row.platform },
  { key: "domains", header: "Domains", numeric: true, cell: (row) => row.domainCount },
];

const DOMAIN_COLUMNS: readonly DataListColumn<Domain>[] = [
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
  { key: "site", header: "Website", cell: (row) => row.siteName ?? "—" },
  { key: "expires", header: "Expires", cell: (row) => formatDateTime(row.expiresAt), className: "whitespace-nowrap" },
];

async function SitesTab({ clientId }: { clientId: string }) {
  const session = await requireAdmin();
  const db = getDb();
  const [sites, domains] = await Promise.all([
    listSites(db, session.organisationId, { clientId }),
    listDomains(db, session.organisationId, { clientId }),
  ]);

  return (
    <>
      <Section title="Websites" description="Every site we build, host or look after for this client.">
        <div className="mb-4 rounded-xl border bg-card p-4">
          <AddSiteForm clientId={clientId} />
        </div>
        <DataList
          rows={sites}
          columns={SITE_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Websites"
          empty={<EmptyState icon={Globe}>No websites yet. Add the first one above.</EmptyState>}
        />
      </Section>

      <Section title="Domains" description="A domain can be added before the website it will point at exists.">
        <div className="mb-4 rounded-xl border bg-card p-4">
          <AddDomainForm clientId={clientId} />
        </div>
        <DataList
          rows={domains}
          columns={DOMAIN_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Domains"
          empty={<EmptyState icon={Network}>No domains yet. Add the first one above.</EmptyState>}
        />
      </Section>
    </>
  );
}
