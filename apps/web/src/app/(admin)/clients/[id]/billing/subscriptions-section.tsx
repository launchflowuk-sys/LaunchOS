import {
  activeSubscriptionForClient,
  findPendingSubscriptionChange,
  getPackage,
  listPackages,
  SUBSCRIPTION_CHANGE_LABEL,
  SubscriptionChangePayload,
} from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import { Receipt } from "lucide-react";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { DataList, type DataListColumn } from "@/components/data-list";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { EmptyState } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { cancelSubscriptionAction, startSubscriptionAction } from "./actions";
import { RaiseInvoiceButton } from "./raise-invoice-button";

type InvoiceRow = {
  id: string;
  number: string;
  status: string;
  issuedAt: Date | null;
  totalPence: number;
  currency: string;
};

const INVOICE_COLUMNS: readonly DataListColumn<InvoiceRow>[] = [
  {
    key: "number",
    header: "Number",
    primary: true,
    cell: (row) => (
      <Link href={`/invoices/${row.id}`} className="hover:underline">
        {row.number}
      </Link>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <StatusBadge value={row.status} /> },
  { key: "issued", header: "Issued", cell: (row) => formatDate(row.issuedAt), className: "whitespace-nowrap" },
  {
    key: "total",
    header: "Total",
    numeric: true,
    className: "font-medium text-foreground",
    cell: (row) => formatPence(row.totalPence, row.currency),
  },
];

/**
 * The subscription half of the client's Contacts & Billing tab: what the client
 * pays monthly, and the invoices that retainer has produced.
 */
export async function SubscriptionsSection({ clientId }: { clientId: string }) {
  const session = await requireAdmin();
  const db = getDb();

  const [subscription, packages, pendingChange, invoices] = await Promise.all([
    activeSubscriptionForClient(db, session.organisationId, clientId),
    listPackages(db, session.organisationId, { activeOnly: true }),
    findPendingSubscriptionChange(db, session.organisationId, clientId),
    db
      .select({
        id: schema.invoices.id,
        number: schema.invoices.number,
        status: schema.invoices.status,
        issuedAt: schema.invoices.issuedAt,
        totalPence: schema.invoices.totalPence,
        currency: schema.invoices.currency,
      })
      .from(schema.invoices)
      .where(and(
        eq(schema.invoices.organisationId, session.organisationId),
        eq(schema.invoices.clientId, clientId),
      ))
      .orderBy(desc(schema.invoices.issuedAt))
      .limit(20),
  ]);

  const pkg = subscription?.packageId ? await getPackage(db, session.organisationId, subscription.packageId) : null;
  const pendingRequest = pendingChange ? SubscriptionChangePayload.safeParse(pendingChange.payload) : undefined;

  return (
    <>
      <Section
        title="Subscription"
        description="Billing runs through the payments provider. Card and bank numbers are never stored here."
        actions={
          subscription ? (
            <>
              <RaiseInvoiceButton clientId={clientId} />
              <ActionForm
                action={cancelSubscriptionAction}
                ariaLabel="Cancel this subscription"
                success="Subscription cancelled"
              >
                <input type="hidden" name="clientId" value={clientId} />
                <input type="hidden" name="subscriptionId" value={subscription.id} />
                <Button type="submit" variant="destructive" className="max-sm:w-full">
                  Cancel subscription
                </Button>
              </ActionForm>
            </>
          ) : null
        }
      >
        {pendingChange ? (
          <InlineAlert
            tone="warning"
            title="Pending change request"
            className="mb-4"
            action={
              <Button asChild variant="secondary" size="sm">
                <Link href="/approvals">Decide in Approvals</Link>
              </Button>
            }
          >
            <p>
              {pendingRequest?.success
                ? `${pendingRequest.data.summary} — asked ${formatDateTime(pendingChange.createdAt)}.`
                : `The client has asked to change their plan (${formatDateTime(pendingChange.createdAt)}).`}
              {pendingRequest?.success ? ` (${SUBSCRIPTION_CHANGE_LABEL[pendingRequest.data.kind]})` : ""}
            </p>
          </InlineAlert>
        ) : null}
        <div className="rounded-xl border bg-card p-4">
          {subscription ? (
            <KeyValue
              columns={2}
              items={[
                { label: "Package", value: pkg?.name ?? "Monthly retainer" },
                {
                  label: "Monthly",
                  value: (
                    <span className="font-medium tabular-nums">
                      {formatPence(subscription.amountPence, subscription.currency)}
                    </span>
                  ),
                },
                { label: "Status", value: <StatusBadge value={subscription.status} /> },
                {
                  label: "Current period",
                  value: `${formatDate(subscription.currentPeriodStart)} to ${formatDate(subscription.currentPeriodEnd)}`,
                },
              ]}
            />
          ) : packages.length === 0 ? (
            <EmptyState icon={Receipt}>
              No active packages. Create one under Settings → Packages before starting a subscription.
            </EmptyState>
          ) : (
            <ActionForm
              action={startSubscriptionAction}
              ariaLabel="Start a subscription"
              success="Subscription started"
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <input type="hidden" name="clientId" value={clientId} />
              <div className="min-w-0 space-y-1.5 sm:w-80">
                <Label htmlFor="subscription-package">Package</Label>
                <NativeSelect id="subscription-package" name="packageId" required defaultValue="">
                  <option value="" disabled>
                    Choose a package
                  </option>
                  {packages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {formatPence(p.monthlyPricePence, p.currency)} a month
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Button type="submit" className="max-sm:w-full">
                Start subscription
              </Button>
            </ActionForm>
          )}
        </div>
      </Section>

      <Section title="Invoices" description="Everything this retainer has produced.">
        <DataList
          rows={invoices}
          columns={INVOICE_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Invoices for this client"
          empty={<EmptyState icon={Receipt}>No invoices yet. Raise one from the active subscription above.</EmptyState>}
        />
      </Section>
    </>
  );
}
