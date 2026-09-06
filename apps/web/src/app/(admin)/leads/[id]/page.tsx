import { getLead, listPackages } from "@launchos/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { updateLeadStatusAction } from "../actions";
import { LeadStatusBadge } from "../lead-status-badge";
import { LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL, MANUAL_LEAD_STATUSES } from "../schemas";
import { ConvertLeadForm } from "./convert-lead-form";

export const dynamic = "force-dynamic";

/** What the lead's metadata knows that is worth a row: where the form was, a Checkout session. */
function metadataRows(metadata: Record<string, unknown>): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (typeof metadata.page === "string") rows.push({ label: "Page", value: metadata.page });
  if (typeof metadata.packageSlug === "string") rows.push({ label: "Package chosen", value: metadata.packageSlug });
  if (typeof metadata.checkoutSessionId === "string") rows.push({ label: "Checkout session", value: metadata.checkoutSessionId });
  return rows;
}

export default async function LeadPage({ params }: PageProps<"/leads/[id]">) {
  const session = await requireAdmin();
  const id = uuidOr404((await params).id);
  const db = getDb();

  const [lead, packages] = await Promise.all([
    getLead(db, session.organisationId, id),
    listPackages(db, session.organisationId, { activeOnly: true }),
  ]);
  if (!lead) notFound();

  const isConverted = lead.status === "converted";
  const metadata = (lead.metadata ?? {}) as Record<string, unknown>;

  return (
    <>
      <PageHeader
        title={lead.business ?? lead.name}
        description={`${LEAD_SOURCE_LABEL[lead.source] ?? lead.source} · received ${formatDateTime(lead.createdAt)}`}
        category="delivery"
        actions={
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto sm:justify-end">
            <LeadStatusBadge status={lead.status} />
            <Button asChild variant="secondary">
              <Link href="/leads">All leads</Link>
            </Button>
          </div>
        }
      />

      {isConverted && lead.clientId ? (
        <InlineAlert
          tone="success"
          title="Converted"
          className="mb-6"
          action={
            <Button asChild variant="secondary" size="sm">
              <Link href={`/clients/${lead.clientId}`}>Open the client</Link>
            </Button>
          }
        >
          This lead is now a client. Nothing more happens here.
        </InlineAlert>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <Section title="Message" description="What they wrote, exactly as it arrived.">
            <div className="rounded-xl border bg-card p-4">
              {lead.message ? (
                <p className="text-sm break-words whitespace-pre-wrap">{lead.message}</p>
              ) : (
                <p className="text-sm text-muted-foreground">No message — just the details.</p>
              )}
            </div>
          </Section>

          {!isConverted ? (
            <Section
              title="Convert to client"
              description="Makes a client record from these details and links the two. The email, phone and message carry over."
            >
              <ConvertLeadForm
                leadId={lead.id}
                defaultName={lead.business ?? lead.name}
                packages={packages.map((pkg) => ({ value: pkg.id, label: pkg.name }))}
              />
            </Section>
          ) : null}
        </div>

        <div className="min-w-0">
          <Section title="Details">
            <div className="rounded-xl border bg-card p-4">
              <KeyValue
                items={[
                  { label: "Name", value: lead.name },
                  { label: "Business", value: lead.business ?? "—" },
                  {
                    label: "Email",
                    value: lead.email ? (
                      <a href={`mailto:${lead.email}`} className="text-primary underline underline-offset-2">
                        {lead.email}
                      </a>
                    ) : (
                      "—"
                    ),
                  },
                  {
                    label: "Phone",
                    value: lead.phone ? (
                      <a href={`tel:${lead.phone}`} className="text-primary underline underline-offset-2">
                        {lead.phone}
                      </a>
                    ) : (
                      "—"
                    ),
                  },
                  { label: "Source", value: LEAD_SOURCE_LABEL[lead.source] ?? lead.source },
                  ...metadataRows(metadata),
                  { label: "Last changed", value: formatDateTime(lead.updatedAt) },
                ]}
              />
            </div>
          </Section>

          {!isConverted ? (
            <Section title="Status" description="Where this lead is. Converting is the button on the left.">
              <ActionForm action={updateLeadStatusAction} ariaLabel="Change status" success="Status saved" className="grid gap-3 rounded-xl border bg-card p-4">
                <input type="hidden" name="leadId" value={lead.id} />
                <div className="space-y-1.5">
                  <Label htmlFor="lead-status">Status</Label>
                  <NativeSelect id="lead-status" name="status" defaultValue={lead.status}>
                    {MANUAL_LEAD_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {LEAD_STATUS_LABEL[status]}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <Button type="submit" variant="secondary" className="max-sm:w-full sm:justify-self-end">
                  Save status
                </Button>
              </ActionForm>
            </Section>
          ) : null}
        </div>
      </div>
    </>
  );
}
