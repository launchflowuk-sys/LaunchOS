import { getClient, listClientUsers } from "@launchos/core";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { ClientTabs } from "../tabs";
import { InvitePortalUserForm } from "./invite-form";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = { client_admin: "Admin", client_member: "Member" };

export default async function ClientPortalUsersPage({ params }: PageProps<"/clients/[id]/portal-users">) {
  const session = await requireAdmin();
  const { id } = await params;
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
        actions={<InvitePortalUserForm clientId={client.id} />}
      />

      <ClientTabs clientId={client.id} active="portal-users" />

      <h2 className="mb-3 text-sm font-semibold text-neutral-900">Portal users</h2>

      {users.length === 0 ? (
        <EmptyState>No portal users yet. Invite one so this client can see their own sites, tasks and tickets.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium text-neutral-900">{user.name}</TableCell>
                  <TableCell className="text-neutral-600">{user.email}</TableCell>
                  <TableCell>
                    <StatusBadge value={ROLE_LABELS[user.role] ?? user.role} tone="info" />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-neutral-600">{formatDateTime(user.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="mt-4 text-xs text-neutral-400">
        A one-time password is generated when the account is created and shown once. It is never stored in plain text,
        so a lost one has to be reset rather than looked up.
      </p>
    </>
  );
}
