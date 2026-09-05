import { getClient, listClientUsers } from "@launchos/core";
import { UserPlus } from "lucide-react";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { ClientTabs } from "../tabs";
import { setPortalUserStatusAction } from "./actions";
import { InvitePortalUserForm } from "./invite-form";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = { client_admin: "Admin", client_member: "Member" };

type PortalUserRow = Awaited<ReturnType<typeof listClientUsers>>[number] & { clientId: string };

const COLUMNS: readonly DataListColumn<PortalUserRow>[] = [
  { key: "name", header: "Name", primary: true, cell: (row) => row.name },
  { key: "email", header: "Email", cell: (row) => <span className="break-all">{row.email}</span> },
  {
    key: "role",
    header: "Role",
    cell: (row) => <StatusBadge value={ROLE_LABELS[row.role] ?? row.role} tone="info" />,
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  {
    key: "added",
    header: "Added",
    hideOnMobile: true,
    className: "whitespace-nowrap",
    cell: (row) => formatDateTime(row.createdAt),
  },
  {
    key: "access",
    header: "Access",
    action: true,
    cell: (row) => (
      <ActionForm
        action={setPortalUserStatusAction}
        className="inline-flex max-sm:w-full"
        ariaLabel={`Portal access for ${row.email}`}
        success={row.status === "active" ? "Portal access suspended." : "Portal access restored."}
      >
        <input type="hidden" name="clientId" value={row.clientId} />
        <input type="hidden" name="clientUserId" value={row.id} />
        <input type="hidden" name="status" value={row.status === "active" ? "suspended" : "active"} />
        <Button type="submit" size="sm" variant={row.status === "active" ? "destructive" : "secondary"}>
          {row.status === "active" ? "Suspend" : "Reactivate"}
        </Button>
      </ActionForm>
    ),
  },
];

export default async function ClientPortalUsersPage({ params }: PageProps<"/clients/[id]/portal-users">) {
  const session = await requireAdmin();
  const id = uuidOr404((await params).id);
  const db = getDb();

  // The org-scoped read `assertOwned` would perform, and the name for the
  // header: a client of another organisation is a 404 rather than an error page.
  const client = await getClient(db, session.organisationId, id);
  if (!client) notFound();

  const users = await listClientUsers(db, session.organisationId, client.id);

  return (
    <>
      <PageHeader
        title={client.name}
        description="Who at this client can sign in to the portal. Sign-up is disabled: accounts are created here."
        category="delivery"
        actions={<InvitePortalUserForm clientId={client.id} />}
      />

      <ClientTabs clientId={client.id} active="portal-users" />

      <Section title="Portal users">
        <DataList
          rows={users.map((user) => ({ ...user, clientId: client.id }))}
          columns={COLUMNS}
          getRowKey={(row) => row.id}
          caption="Portal users"
          empty={
            <EmptyState icon={UserPlus}>
              No portal users yet. Invite one so this client can see their own sites, tasks and tickets.
            </EmptyState>
          }
        />

        <p className="mt-4 text-meta text-muted-foreground">
          A one-time password is generated when the account is created and shown once. It is never stored in plain text,
          so a lost one has to be reset rather than looked up. Suspending an account removes portal access on their next
          request and can be undone; the sign-in itself is kept so the audit trail still names who did what.
        </p>
      </Section>
    </>
  );
}
