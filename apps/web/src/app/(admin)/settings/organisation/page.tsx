import { supportEmailDomain } from "@launchos/core";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { updateOrganisationAction } from "./actions";

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
      <Input id={name} name={name} defaultValue={defaultValue ?? ""} className="mt-1" />
      {hint ? <p className="mt-1 text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

export default async function OrganisationSettingsPage() {
  const session = await requireAdmin();
  const [organisation] = await getDb()
    .select()
    .from(schema.organisations)
    .where(eq(schema.organisations.id, session.organisationId));
  if (!organisation) notFound();

  const isOwner = session.role === "owner";

  return (
    <>
      <PageHeader title="Organisation" description="Who this LaunchOS runs for, and where client mail lands." />

      <dl className="grid grid-cols-1 gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Name</dt>
          <dd className="mt-1 text-neutral-900">{organisation.name}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Slug</dt>
          <dd className="mt-1 text-neutral-700">{organisation.slug}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Status</dt>
          <dd className="mt-1">
            <StatusBadge value={organisation.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Created</dt>
          <dd className="mt-1 text-neutral-700">{formatDateTime(organisation.createdAt)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Support email domain</dt>
          <dd className="mt-1 text-neutral-900">
            <code className="rounded bg-neutral-100 px-1.5 py-0.5">{supportEmailDomain()}</code>
            <span className="ml-2 text-xs text-neutral-500">
              Every client address is <code>slug@{supportEmailDomain()}</code>. Change it with the{" "}
              <code>SUPPORT_EMAIL_DOMAIN</code> environment variable.
            </span>
          </dd>
        </div>
      </dl>

      <section className="mt-8 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-900">Invoice details</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Printed on every invoice, in the portal and on{" "}
          <Link href="/invoices" className="underline">
            Invoices
          </Link>
          . HMRC requires a VAT invoice to carry the supplier&rsquo;s name, address and VAT registration number, so an
          invoice is only a valid one once these are filled in. Leave <strong>VAT number</strong> empty if you are not
          registered and invoices will print &ldquo;VAT not registered&rdquo; with no VAT line.
        </p>

        {isOwner ? (
          <ActionForm
            action={updateOrganisationAction}
            ariaLabel="Organisation invoice details"
            success="Invoice details saved"
            className="mt-4"
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
                  className="mt-1"
                />
                <p className="mt-1 text-xs text-neutral-500">
                  Printed under the payment terms — bank details, or anything else every invoice should say.
                </p>
              </div>
            </div>
            <div className="mt-4">
              <Button type="submit">Save invoice details</Button>
            </div>
          </ActionForm>
        ) : (
          <dl className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-neutral-400">Legal name</dt>
              <dd className="mt-1 text-neutral-900">{organisation.legalName ?? organisation.name}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-400">VAT number</dt>
              <dd className="mt-1 text-neutral-900">{organisation.vatNumber ?? "Not registered"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-400">Company number</dt>
              <dd className="mt-1 text-neutral-900">{organisation.companyNumber ?? "—"}</dd>
            </div>
            <p className="text-xs text-neutral-500 sm:col-span-2">Only an owner can change these.</p>
          </dl>
        )}
      </section>

      <p className="mt-4 text-sm text-neutral-500">
        Agent enablement lives on{" "}
        <Link href="/settings/agents" className="underline">
          Settings → Agents
        </Link>
        .
      </p>
    </>
  );
}
