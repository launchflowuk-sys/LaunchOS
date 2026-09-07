import {
  getAssignmentRules,
  getBookingSettings,
  listMembers,
  SUPPORT_ASSIGNMENT_LABELS,
  SUPPORT_ASSIGNMENT_RULES,
  supportEmailDomain,
  TASK_ASSIGNMENT_LABELS,
  TASK_ASSIGNMENT_RULES,
} from "@launchos/core";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { KeyValue } from "@/components/key-value";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { sessionPermissions } from "@/lib/permissions";
import { requireAdmin } from "@/lib/session";
import { updateAssignmentRulesAction, updateOrganisationAction } from "./actions";
import { BookingSection } from "./booking-section";

export const dynamic = "force-dynamic";

function Field({
  name,
  label,
  defaultValue,
  hint,
  className,
}: {
  name: string;
  label: string;
  defaultValue: string | null;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} defaultValue={defaultValue ?? ""} className="mt-1.5" />
      {hint ? <p className="mt-1.5 text-meta text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export default async function OrganisationSettingsPage() {
  const session = await requireAdmin();
  const [[organisation], permissions, assignment, booking, members] = await Promise.all([
    getDb().select().from(schema.organisations).where(eq(schema.organisations.id, session.organisationId)),
    sessionPermissions(),
    getAssignmentRules(getDb(), session.organisationId),
    getBookingSettings(getDb(), session.organisationId),
    listMembers(getDb(), session.organisationId),
  ]);
  if (!organisation) notFound();
  // Whose diary the booking page fills: any active member. Core refuses the rest.
  const hosts = members
    .filter((member) => member.status === "active")
    .map((member) => ({ userId: member.userId, label: member.displayName ?? member.name }));

  const isOwner = session.role === "owner";
  // The action gates on `settings`; the form is only drawn for those who pass.
  const canEditAssignment = isOwner || permissions.settings;

  return (
    <>
      <PageHeader
        title="Organisation"
        description="Who this LaunchOS runs for, and where client mail lands."
        category="organisation"
      />

      <Section title="This organisation">
        <div className="rounded-xl border bg-card p-4 sm:p-5">
          <KeyValue
            columns={2}
            items={[
              { label: "Name", value: organisation.name },
              { label: "Slug", value: organisation.slug },
              { label: "Status", value: <StatusBadge value={organisation.status} /> },
              { label: "Created", value: formatDateTime(organisation.createdAt) },
              {
                label: "Support email domain",
                value: <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{supportEmailDomain()}</code>,
                hint: `Every client address is slug@${supportEmailDomain()}. Change it with the SUPPORT_EMAIL_DOMAIN environment variable.`,
              },
            ]}
          />
        </div>
      </Section>

      <Section
        title="Invoice details"
        description="Printed on every invoice, in the portal and on Invoices. HMRC requires a VAT invoice to carry the supplier's name, address and VAT registration number, so an invoice is only a valid one once these are filled in. Leave VAT number empty if you are not registered and invoices will print “VAT not registered” with no VAT line."
      >
        {isOwner ? (
          <ActionForm
            action={updateOrganisationAction}
            ariaLabel="Organisation invoice details"
            success="Invoice details saved"
            className="space-y-4 rounded-xl border bg-card p-4 sm:p-5"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                name="legalName"
                label="Legal name"
                defaultValue={organisation.legalName}
                hint={`Falls back to "${organisation.name}" when empty.`}
                className="sm:col-span-2"
              />
              <Field name="addressLine1" label="Address line 1" defaultValue={organisation.addressLine1} />
              <Field name="addressLine2" label="Address line 2" defaultValue={organisation.addressLine2} />
              <Field name="city" label="City" defaultValue={organisation.city} />
              <Field name="postcode" label="Postcode" defaultValue={organisation.postcode} />
              <Field
                name="country"
                label="Country"
                defaultValue={organisation.country}
                hint='Two-letter ISO code, e.g. "GB".'
              />
              <Field
                name="vatNumber"
                label="VAT number"
                defaultValue={organisation.vatNumber}
                hint="Empty means not VAT registered — invoices raised are then zero-rated."
              />
              <Field
                name="companyNumber"
                label="Company number"
                defaultValue={organisation.companyNumber}
                className="sm:col-span-2"
              />
              <div className="sm:col-span-2">
                <Label htmlFor="invoiceFooter">Invoice footer</Label>
                <Textarea
                  id="invoiceFooter"
                  name="invoiceFooter"
                  rows={3}
                  defaultValue={organisation.invoiceFooter ?? ""}
                  className="mt-1.5"
                />
                <p className="mt-1.5 text-meta text-muted-foreground">
                  Printed under the payment terms — bank details, or anything else every invoice should say.
                </p>
              </div>
            </div>
            <div className="flex justify-end max-sm:[&>*]:w-full">
              <Button type="submit">Save invoice details</Button>
            </div>
          </ActionForm>
        ) : (
          <div className="rounded-xl border bg-card p-4 sm:p-5">
            <KeyValue
              columns={2}
              items={[
                { label: "Legal name", value: organisation.legalName ?? organisation.name },
                { label: "VAT number", value: organisation.vatNumber ?? "Not registered" },
                { label: "Company number", value: organisation.companyNumber ?? "—" },
              ]}
            />
            <p className="mt-4 text-meta text-muted-foreground">Only an owner can change these.</p>
          </div>
        )}
      </Section>

      <Section
        title="Assignment"
        description="Who a new support case or a generated task lands with. The owner is always the fallback, every automatic assignment is audited, and the person assigned is told."
      >
        {canEditAssignment ? (
          <ActionForm
            action={updateAssignmentRulesAction}
            ariaLabel="Assignment rules"
            success="Assignment rules saved"
            className="space-y-4 rounded-xl border bg-card p-4 sm:p-5"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="assignment-support">Support cases</Label>
                <NativeSelect key={assignment.support} id="assignment-support" name="support" defaultValue={assignment.support} className="mt-1.5">
                  {SUPPORT_ASSIGNMENT_RULES.map((rule) => (
                    <option key={rule} value={rule}>
                      {SUPPORT_ASSIGNMENT_LABELS[rule]}
                    </option>
                  ))}
                </NativeSelect>
                <p className="mt-1.5 text-meta text-muted-foreground">
                  Only members with the support permission are considered. Cases that arrive by email are routed too.
                </p>
              </div>
              <div>
                <Label htmlFor="assignment-tasks">Generated tasks</Label>
                <NativeSelect key={assignment.tasks} id="assignment-tasks" name="tasks" defaultValue={assignment.tasks} className="mt-1.5">
                  {TASK_ASSIGNMENT_RULES.map((rule) => (
                    <option key={rule} value={rule}>
                      {TASK_ASSIGNMENT_LABELS[rule]}
                    </option>
                  ))}
                </NativeSelect>
                <p className="mt-1.5 text-meta text-muted-foreground">
                  Onboarding and recurring tasks as they are generated; content work needs the content permission.
                </p>
              </div>
            </div>
            <div className="flex justify-end max-sm:[&>*]:w-full">
              <Button type="submit">Save assignment rules</Button>
            </div>
          </ActionForm>
        ) : (
          <div className="rounded-xl border bg-card p-4 sm:p-5">
            <KeyValue
              columns={2}
              items={[
                { label: "Support cases", value: SUPPORT_ASSIGNMENT_LABELS[assignment.support] },
                { label: "Generated tasks", value: TASK_ASSIGNMENT_LABELS[assignment.tasks] },
              ]}
            />
            <p className="mt-4 text-meta text-muted-foreground">Only a member with the settings permission can change these.</p>
          </div>
        )}
      </Section>

      <BookingSection settings={booking} hosts={hosts} canEdit={canEditAssignment} />

      <p className="mt-8 text-sm text-muted-foreground">
        Agent enablement lives on{" "}
        <Link href="/settings/agents" className="underline hover:text-foreground">
          Settings → Agents
        </Link>
        . Invoices are listed on{" "}
        <Link href="/invoices" className="underline hover:text-foreground">
          Invoices
        </Link>
        .
      </p>
    </>
  );
}
