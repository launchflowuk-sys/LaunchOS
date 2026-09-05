import { activeSubscriptionForClient, getPackage, listPackages } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { EmptyState } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDate, formatPence } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { cancelSubscriptionAction, startSubscriptionAction } from "./actions";
import { RaiseInvoiceButton } from "./raise-invoice-button";

const FIELD = "h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 sm:w-80";

/**
 * The subscription half of the client's Contacts & Billing tab: what the client
 * pays monthly, and the invoices that retainer has produced.
 */
export async function SubscriptionsSection({ clientId }: { clientId: string }) {
  const session = await requireAdmin();
  const db = getDb();

  const [subscription, packages, invoices] = await Promise.all([
    activeSubscriptionForClient(db, session.organisationId, clientId),
    listPackages(db, session.organisationId, { activeOnly: true }),
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

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Subscription</h2>
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          {subscription ? (
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-neutral-900">
                  {pkg?.name ?? "Monthly retainer"} · {formatPence(subscription.amountPence, subscription.currency)} a month
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  <StatusBadge value={subscription.status} /> current period {formatDate(subscription.currentPeriodStart)} to{" "}
                  {formatDate(subscription.currentPeriodEnd)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <RaiseInvoiceButton clientId={clientId} />
                <ActionForm
                  action={cancelSubscriptionAction}
                  ariaLabel="Cancel this subscription"
                  success="Subscription cancelled"
                >
                  <input type="hidden" name="clientId" value={clientId} />
                  <input type="hidden" name="subscriptionId" value={subscription.id} />
                  <Button type="submit" variant="secondary">
                    Cancel subscription
                  </Button>
                </ActionForm>
              </div>
            </div>
          ) : packages.length === 0 ? (
            <EmptyState>
              No active packages. Create one under Settings → Packages before starting a subscription.
            </EmptyState>
          ) : (
            <ActionForm
              action={startSubscriptionAction}
              ariaLabel="Start a subscription"
              success="Subscription started"
              className="flex flex-wrap items-end gap-3"
            >
              <input type="hidden" name="clientId" value={clientId} />
              <label className="block text-xs text-neutral-500">
                Package
                <select name="packageId" required defaultValue="" className={FIELD}>
                  <option value="" disabled>
                    Choose a package
                  </option>
                  {packages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {formatPence(p.monthlyPricePence, p.currency)} a month
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit">Start subscription</Button>
            </ActionForm>
          )}
          <p className="mt-3 text-xs text-neutral-400">
            Billing runs through the payments provider. Card and bank numbers are never stored here.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Invoices</h2>
        {invoices.length === 0 ? (
          <EmptyState>No invoices yet. Raise one from the active subscription above.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell>
                      <Link href={`/invoices/${invoice.id}`} className="font-medium text-neutral-900 hover:underline">
                        {invoice.number}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={invoice.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-neutral-600">{formatDate(invoice.issuedAt)}</TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-900">
                      {formatPence(invoice.totalPence, invoice.currency)}
                    </TableCell>
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
