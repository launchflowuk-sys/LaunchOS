import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { Link2 } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { DomainStatusBadge } from "@/components/portal/portal-status";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

type DomainRow = {
  id: string;
  name: string;
  registrar: string | null;
  expiresAt: Date | null;
  autoRenew: boolean;
  status: string;
};

const COLUMNS: readonly DataListColumn<DomainRow>[] = [
  { key: "name", header: "Domain", primary: true, cell: (row) => <span className="break-all">{row.name}</span> },
  { key: "registrar", header: "Registered with", hideOnMobile: true, cell: (row) => row.registrar ?? "—" },
  { key: "expires", header: "Renews", cell: (row) => formatDate(row.expiresAt) },
  {
    key: "autoRenew",
    header: "Auto-renew",
    // A domain that will not renew itself is the one thing on this screen a
    // client may need to act on, so both states are worded rather than ticked.
    // What "on" means is said once, in the page description, not on every row.
    cell: (row) => (row.autoRenew ? "On" : "Off"),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <DomainStatusBadge value={row.status} /> },
];

export default async function PortalDomainsPage() {
  const session = await requireClient();

  // Queried directly rather than through `listDomains`, which joins the client
  // and site tables to build the admin row. The portal shows neither, and both
  // halves of the scope — organisation and client — are on `domains` itself.
  const rows = await getDb()
    .select({
      id: schema.domains.id,
      name: schema.domains.name,
      registrar: schema.domains.registrar,
      expiresAt: schema.domains.expiresAt,
      autoRenew: schema.domains.autoRenew,
      status: schema.domains.status,
    })
    .from(schema.domains)
    .where(
      and(
        eq(schema.domains.organisationId, session.organisationId),
        eq(schema.domains.clientId, session.clientId),
      ),
    )
    .orderBy(asc(schema.domains.name));

  return (
    <>
      <PageHeader
        title="Domains"
        description="The domain names registered for you. Anything with auto-renew on, we renew for you."
        category="delivery"
      />

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Your domains"
        empty={
          <EmptyState icon={Link2}>
            No domains on your account yet. Raise a request if you would like us to register one.
          </EmptyState>
        }
      />
    </>
  );
}
