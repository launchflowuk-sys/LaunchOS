import { listContacts } from "@launchos/core";
import { Users } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { KeyValue } from "@/components/key-value";
import { SignOutButton } from "@/components/portal/sign-out-button";
import { Section } from "@/components/section";
import { getDb } from "@/lib/db";
import { requireClient } from "@/lib/portal-session";
import { ChangePasswordForm } from "./change-password-form";

export const dynamic = "force-dynamic";

type ContactRow = {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
};

const CONTACT_COLUMNS: readonly DataListColumn<ContactRow>[] = [
  {
    key: "name",
    header: "Name",
    primary: true,
    cell: (row) => (
      <>
        {row.name}
        {row.isPrimary ? <span className="ml-2 text-meta text-muted-foreground">Main contact</span> : null}
      </>
    ),
  },
  { key: "role", header: "Role", cell: (row) => row.role ?? "—" },
  { key: "email", header: "Email", cell: (row) => <span className="break-all">{row.email ?? "—"}</span> },
  { key: "phone", header: "Phone", cell: (row) => row.phone ?? "—" },
];

export default async function PortalAccountPage() {
  const session = await requireClient();
  const contacts = await listContacts(getDb(), session.organisationId, session.clientId);

  return (
    <>
      <PageHeader
        title="Account"
        description="Who we hold on file for you, and your sign-in details."
        category="organisation"
      />

      <Section title="Signed in as">
        <div className="rounded-xl border bg-card p-5">
          <KeyValue
            columns={2}
            items={[
              { label: "Name", value: session.name },
              { label: "Email", value: <span className="break-all">{session.email}</span> },
              { label: "Account", value: session.clientName },
            ]}
          />
          <div className="mt-5 max-sm:[&>*]:w-full">
            <SignOutButton />
          </div>
        </div>
      </Section>

      <Section
        title="Contacts"
        description="We keep these up to date for you. Raise a support request to have one changed."
      >
        <DataList
          rows={contacts}
          columns={CONTACT_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Contacts on file"
          empty={
            <EmptyState icon={Users}>
              No contacts on file. Raise a support request if that needs correcting.
            </EmptyState>
          }
        />
      </Section>

      <Section title="Password" description="Changing it signs you out everywhere else.">
        <div className="max-w-xl rounded-xl border bg-card p-5 sm:p-6">
          <ChangePasswordForm />
        </div>
      </Section>
    </>
  );
}
