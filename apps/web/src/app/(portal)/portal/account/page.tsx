import { listContacts } from "@launchos/core";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { requireClient } from "@/lib/portal-session";
import { ChangePasswordForm } from "./change-password-form";

export const dynamic = "force-dynamic";

export default async function PortalAccountPage() {
  const session = await requireClient();
  const contacts = await listContacts(getDb(), session.organisationId, session.clientId);

  return (
    <>
      <PageHeader title="Account" description="Who we hold on file for you, and your sign-in details." />

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Signed in as</h2>
        <div className="rounded-lg border border-neutral-200 bg-white p-5 text-sm">
          <p className="font-medium text-neutral-900">{session.name}</p>
          <p className="mt-1 text-neutral-600">{session.email}</p>
          <p className="mt-1 text-xs text-neutral-500">{session.clientName}</p>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Contacts</h2>
        {contacts.length === 0 ? (
          <EmptyState>No contacts on file. Raise a support request if that needs correcting.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.map((contact) => (
                  <TableRow key={contact.id}>
                    <TableCell className="font-medium text-neutral-900">
                      {contact.name}
                      {contact.isPrimary ? <span className="ml-2 text-xs text-neutral-500">Primary</span> : null}
                    </TableCell>
                    <TableCell className="text-neutral-600">{contact.role ?? "—"}</TableCell>
                    <TableCell className="text-neutral-600">{contact.email ?? "—"}</TableCell>
                    <TableCell className="text-neutral-600">{contact.phone ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="mt-2 text-xs text-neutral-500">
          Contacts are maintained by us. Raise a support request to have one changed.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Password</h2>
        <div className="rounded-lg border border-neutral-200 bg-white p-5">
          <ChangePasswordForm />
        </div>
      </section>
    </>
  );
}
