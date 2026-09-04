import { getBillingProfile, getClient, listActivity, listContacts, listDomains, listSites } from "@launchos/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { archiveClientAction, deleteContactAction } from "../actions";
import { AddContactForm, AddDomainForm, AddSiteForm, BillingForm } from "./forms";
import { CLIENT_TABS, ClientTabs, type ClientTabKey } from "./tabs";

export const dynamic = "force-dynamic";

export default async function ClientDetailPage({ params, searchParams }: PageProps<"/clients/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  const session = await requireAdmin();
  const db = getDb();

  const client = await getClient(db, session.organisationId, id);
  if (!client) notFound();

  const requested = typeof query.tab === "string" ? query.tab : "overview";
  const tab: ClientTabKey = CLIENT_TABS.some((t) => t.key === requested) ? (requested as ClientTabKey) : "overview";
  // The two plain-form actions (archive, remove contact) cannot return a value,
  // so a failure is carried back on the URL and rendered here.
  const error = typeof query.error === "string" ? query.error : null;

  return (
    <>
      <PageHeader
        title={client.name}
        description={`${client.supportEmail ?? "no support address"} · ${[client.city, client.postcode].filter(Boolean).join(" ") || "no address"}`}
        actions={
          <form action={archiveClientAction}>
            <input type="hidden" name="clientId" value={client.id} />
            <Button type="submit" variant="outline" disabled={client.status === "archived"}>
              Archive
            </Button>
          </form>
        }
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <ClientTabs clientId={client.id} active={tab} />

      {tab === "overview" ? <OverviewTab clientId={client.id} /> : null}
      {tab === "contacts" ? <ContactsTab clientId={client.id} /> : null}
      {tab === "sites" ? <SitesTab clientId={client.id} /> : null}
      {tab === "portal" ? (
        <EmptyState>Portal users arrive in Plan 4, together with the client portal itself.</EmptyState>
      ) : null}
    </>
  );
}

async function OverviewTab({ clientId }: { clientId: string }) {
  const session = await requireAdmin();
  const events = await listActivity(getDb(), session.organisationId, { clientId });

  if (events.length === 0) return <EmptyState>Nothing has happened yet. Add a contact, a domain or a website.</EmptyState>;

  return (
    <ol className="space-y-3">
      {events.map((event) => (
        <li key={event.id} className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-neutral-900">
              {event.link ? (
                <Link href={event.link} className="hover:underline">
                  {event.title}
                </Link>
              ) : (
                event.title
              )}
            </p>
            <p className="text-xs text-neutral-400">
              {formatDateTime(event.createdAt)} · {event.actorKind}
            </p>
          </div>
          {event.body ? <p className="mt-1 text-sm text-neutral-600">{event.body}</p> : null}
        </li>
      ))}
    </ol>
  );
}

async function ContactsTab({ clientId }: { clientId: string }) {
  const session = await requireAdmin();
  const db = getDb();
  const [contacts, billing] = await Promise.all([
    listContacts(db, session.organisationId, clientId),
    getBillingProfile(db, session.organisationId, clientId),
  ]);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Contacts</h2>
        <div className="mb-4 rounded-lg border border-neutral-200 bg-white p-4">
          <AddContactForm clientId={clientId} />
        </div>
        {contacts.length === 0 ? (
          <EmptyState>No contacts yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.map((contact) => (
                  <TableRow key={contact.id}>
                    <TableCell className="font-medium text-neutral-900">
                      {contact.name}
                      {contact.isPrimary ? <StatusBadge value="primary" tone="info" /> : null}
                    </TableCell>
                    <TableCell className="text-neutral-600">{contact.email ?? "—"}</TableCell>
                    <TableCell className="text-neutral-600">{contact.phone ?? "—"}</TableCell>
                    <TableCell className="text-neutral-600">{contact.role ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <form action={deleteContactAction}>
                        <input type="hidden" name="contactId" value={contact.id} />
                        <input type="hidden" name="clientId" value={clientId} />
                        <button type="submit" className="text-xs text-neutral-500 hover:text-red-600">
                          Remove
                        </button>
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Billing</h2>
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
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
          <p className="mt-3 text-xs text-neutral-400">
            Card and bank numbers are never stored. Payment methods live with Stripe from Plan 5.
          </p>
        </div>
      </section>
    </div>
  );
}

async function SitesTab({ clientId }: { clientId: string }) {
  const session = await requireAdmin();
  const db = getDb();
  const [sites, domains] = await Promise.all([
    listSites(db, session.organisationId, { clientId }),
    listDomains(db, session.organisationId, { clientId }),
  ]);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Websites</h2>
        <div className="mb-4 rounded-lg border border-neutral-200 bg-white p-4">
          <AddSiteForm clientId={clientId} />
        </div>
        {sites.length === 0 ? (
          <EmptyState>No websites yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Website</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead className="text-right">Domains</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.map((site) => (
                  <TableRow key={site.id}>
                    <TableCell>
                      <Link href={`/websites/${site.id}`} className="font-medium text-neutral-900 hover:underline">
                        {site.name}
                      </Link>
                      <span className="block text-xs text-neutral-400">{site.primaryUrl}</span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={site.status} />
                    </TableCell>
                    <TableCell className="text-neutral-600">{site.platform}</TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-600">{site.domainCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Domains</h2>
        <div className="mb-4 rounded-lg border border-neutral-200 bg-white p-4">
          <AddDomainForm clientId={clientId} />
        </div>
        {domains.length === 0 ? (
          <EmptyState>No domains yet. A domain can be added before its website exists.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>DNS</TableHead>
                  <TableHead>Website</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((domain) => (
                  <TableRow key={domain.id}>
                    <TableCell>
                      <Link href={`/domains/${domain.id}`} className="font-medium text-neutral-900 hover:underline">
                        {domain.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={domain.status} />
                    </TableCell>
                    <TableCell className="text-neutral-600">{domain.dnsProvider}</TableCell>
                    <TableCell className="text-neutral-600">{domain.siteName ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(domain.expiresAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
