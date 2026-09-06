import { listClients, previewStripeSync, type StripeSyncPreviewProduct, type StripeSyncPreviewSubscription } from "@launchos/core";
import { CreditCard } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { InlineAlert } from "@/components/inline-alert";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate, formatMoney } from "@/lib/format";
import { getPayments } from "@/lib/integrations";
import { requireAdminWith } from "@/lib/permissions";
import { importStripeAction } from "./actions";
import { FileUnderSelect, type FileUnderOption } from "./file-under-select";
import { initialFileUnderChoice } from "./import-form";
import { ProductTick, ReviewFormProvider, type ReviewFormInitial } from "./review-form-state";

export const dynamic = "force-dynamic";

const INTERVAL_LABEL = { day: "day", week: "week", month: "month", year: "year" } as const;

function priceLabel(price: StripeSyncPreviewProduct["prices"][number]): string {
  const every = price.intervalCount === 1 ? INTERVAL_LABEL[price.interval] : `${price.intervalCount} ${INTERVAL_LABEL[price.interval]}s`;
  return `${formatMoney(price.amountPence, price.currency)} / ${every}`;
}

const PRODUCT_COLUMNS: readonly DataListColumn<StripeSyncPreviewProduct>[] = [
  {
    key: "tick",
    header: "Import",
    className: "w-12",
    cell: (p) => <ProductTick productId={p.productId} label={`Import ${p.productName}`} />,
  },
  {
    key: "name",
    header: "Product",
    primary: true,
    cell: (p) => (
      <div className="min-w-0">
        <div className="break-words">{p.productName}</div>
        <div className="font-mono text-meta text-muted-foreground">{p.productId}</div>
      </div>
    ),
  },
  {
    key: "prices",
    header: "Prices",
    cell: (p) => (
      <ul className="space-y-0.5 tabular-nums">
        {p.prices.map((price) => <li key={price.priceId}>{priceLabel(price)}</li>)}
      </ul>
    ),
  },
  {
    key: "package",
    header: "Package",
    cell: (p) => (p.matchedPackageName
      ? <span>Already linked to <span className="font-medium text-foreground">{p.matchedPackageName}</span></span>
      : <span>{p.suggested ? "Will create a package" : p.ignored ? "Left out last time" : "Not a LaunchFlow product?"}</span>),
  },
  {
    key: "status",
    header: "Status",
    status: true,
    cell: (p) => <StatusBadge value={p.productActive ? "active" : "archived"} tone={p.productActive ? "success" : "neutral"} />,
  },
];

/** A match the import will keep whatever the owner does: the customer id is already on one of our clients. */
function matchedByCustomerId(s: StripeSyncPreviewSubscription): boolean {
  return s.matchedBy === "payment_account" || s.matchedBy === "billing_profile";
}

/**
 * The "Client" cell: the client the customer id already belongs to, or the
 * owner's "File under" choice — an email match pre-selected when the preview
 * found one, else "Create new client" with the name the import would use.
 */
function ClientCell({ s, firstForCustomer, clients }: { s: StripeSyncPreviewSubscription; firstForCustomer: boolean; clients: readonly FileUnderOption[] }) {
  if (s.matchedClientId && matchedByCustomerId(s)) {
    return (
      <div className="min-w-0">
        <Link href={`/clients/${s.matchedClientId}`} className="font-medium text-primary hover:underline">{s.matchedClientName}</Link>
        <div className="text-meta text-muted-foreground">Matched by Stripe customer id</div>
      </div>
    );
  }
  if (!firstForCustomer) return <span className="text-meta">Same customer as above</span>;
  return (
    <FileUnderSelect
      customerId={s.customerId}
      customerLabel={s.customerEmail ?? s.customerId}
      matched={s.matchedClientId ? { id: s.matchedClientId, name: s.matchedClientName ?? "Matched client" } : null}
      candidates={s.candidates.map((c) => ({ id: c.clientId, name: c.name, reason: c.reason }))}
      clients={clients}
      cancelled={s.status === "cancelled"}
    />
  );
}

function subscriptionColumns(
  firstRowForCustomer: ReadonlySet<string>,
  clients: readonly FileUnderOption[],
): readonly DataListColumn<StripeSyncPreviewSubscription>[] {
  return [
    {
      key: "customer",
      header: "Customer",
      primary: true,
      cell: (s) => (
        <div className="min-w-0">
          <div className="break-words">{s.customerName ?? s.proposedClientName}</div>
          <div className="font-mono text-meta text-muted-foreground">{s.customerId}</div>
        </div>
      ),
    },
    { key: "email", header: "Email", className: "break-all", cell: (s) => s.customerEmail ?? "—" },
    {
      key: "product",
      header: "Product",
      cell: (s) => (
        <div className="min-w-0">
          <div className="break-words">{s.productName ?? <span className="font-mono">{s.productId}</span>}</div>
          {!s.productSuggested ? <div className="text-meta text-muted-foreground">Product not ticked</div> : null}
        </div>
      ),
    },
    { key: "amount", header: "Amount", numeric: true, cell: (s) => formatMoney(s.amountPence, s.currency) },
    { key: "period", header: "Period ends", hideOnMobile: true, cell: (s) => formatDate(s.currentPeriodEnd) },
    { key: "client", header: "Client", cell: (s) => <ClientCell s={s} firstForCustomer={firstRowForCustomer.has(s.id)} clients={clients} /> },
    { key: "status", header: "Status", status: true, cell: (s) => <StatusBadge value={s.status} /> },
  ];
}

/**
 * Where every control starts, keyed the way the store keeps them. Only the
 * first subscription per customer gets a File-under entry: that row carries
 * the select, later rows of the same customer point at it.
 */
function initialReviewForm(preview: Awaited<ReturnType<typeof previewStripeSync>>, firstRows: ReadonlySet<string>): ReviewFormInitial {
  const placeable = preview.subscriptions.filter((s) => firstRows.has(s.id) && !(s.matchedClientId && matchedByCustomerId(s)));
  return {
    products: Object.fromEntries(preview.products.map((p) => [p.productId, p.suggested])),
    fileUnder: Object.fromEntries(placeable.map((s) => [s.customerId, initialFileUnderChoice(s)])),
    clientNames: Object.fromEntries(placeable.map((s) => [s.customerId, s.proposedClientName])),
  };
}

/** The first subscription row per customer carries the File-under select; later ones point at it. */
function firstRowsPerCustomer(subscriptions: readonly StripeSyncPreviewSubscription[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const first = new Set<string>();
  for (const s of subscriptions) {
    if (seen.has(s.customerId)) continue;
    seen.add(s.customerId);
    first.add(s.id);
  }
  return first;
}

export default async function StripeReviewPage({ searchParams }: PageProps<"/settings/billing/stripe">) {
  const session = await requireAdminWith("settings");
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  const [preview, book] = await Promise.all([
    previewStripeSync(getDb(), session.organisationId, getPayments()),
    // Alphabetical by default; archived clients are not somewhere to file new business.
    listClients(getDb(), session.organisationId, { limit: 200 }),
  ]);
  const clients: FileUnderOption[] = book.filter((c) => c.status !== "archived").map((c) => ({ id: c.id, name: c.name }));
  const firstRows = firstRowsPerCustomer(preview.subscriptions);
  const suggestedCount = preview.products.filter((p) => p.suggested).length;
  const newClientCount = new Set(preview.subscriptions.filter((s) => s.willCreateClient).map((s) => s.customerId)).size;

  return (
    <>
      <PageHeader
        title="Review Stripe import"
        description="Tick the products that are LaunchFlow packages. Every subscription on a ticked product is filed under its client — matched by Stripe customer id, filed under the client you choose, or created with the name shown."
        category="organisation"
        actions={
          <Button asChild variant="secondary">
            <Link href="/settings/billing">Back to Billing</Link>
          </Button>
        }
      />

      {error ? <InlineAlert tone="danger" title="Import failed" className="mb-6">{error}</InlineAlert> : null}
      {preview.adapter !== "stripe" ? (
        <InlineAlert tone="warning" title="Payments adapter is the mock" className="mb-6">
          This deployment is not talking to Stripe (Settings → Billing → Payments). What follows is the mock adapter&rsquo;s
          catalogue, which is empty unless a test seeded it.
        </InlineAlert>
      ) : null}

      <form action={importStripeAction}>
        <ReviewFormProvider initial={initialReviewForm(preview, firstRows)}>
        <Section
          title="Products"
          description={`${preview.products.length} recurring product${preview.products.length === 1 ? "" : "s"} in Stripe, ${suggestedCount} pre-ticked. Products with "LaunchFlow" in the name and the Starter, Standard and Premium plans are ticked for you; anything left unticked is remembered.`}
        >
          <DataList
            rows={preview.products}
            columns={PRODUCT_COLUMNS}
            getRowKey={(p) => p.productId}
            caption="Stripe products"
            empty={<EmptyState icon={CreditCard}>No recurring prices in Stripe yet.</EmptyState>}
          />
        </Section>

        <Section
          title="Subscriptions"
          description={`${preview.subscriptions.length} subscription${preview.subscriptions.length === 1 ? "" : "s"} in every status. ${newClientCount} would create a new client. Cancelled subscriptions are kept as history when their client exists.`}
        >
          <DataList
            rows={preview.subscriptions}
            columns={subscriptionColumns(firstRows, clients)}
            getRowKey={(s) => s.id}
            caption="Stripe subscriptions"
            empty={<EmptyState icon={CreditCard}>No subscriptions in Stripe yet.</EmptyState>}
          />
        </Section>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end max-sm:[&>*]:w-full">
          <Button type="submit" disabled={preview.products.length === 0}>Import selected</Button>
        </div>
        </ReviewFormProvider>
      </form>
    </>
  );
}
