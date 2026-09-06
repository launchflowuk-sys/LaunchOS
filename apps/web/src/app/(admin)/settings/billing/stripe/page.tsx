import { previewStripeSync, type StripeSyncPreviewProduct, type StripeSyncPreviewSubscription } from "@launchos/core";
import { CreditCard } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { InlineAlert } from "@/components/inline-alert";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { getDb } from "@/lib/db";
import { formatDate, formatMoney } from "@/lib/format";
import { getPayments } from "@/lib/integrations";
import { requireAdminWith } from "@/lib/permissions";
import { importStripeAction } from "./actions";

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
    cell: (p) => (
      <Checkbox
        name="product"
        value={p.productId}
        defaultChecked={p.suggested}
        aria-label={`Import ${p.productName}`}
      />
    ),
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

/** The "Client" cell: who the subscription files under, or the name the import will give a new client. */
function ClientCell({ s, firstForCustomer }: { s: StripeSyncPreviewSubscription; firstForCustomer: boolean }) {
  if (s.matchedClientId) {
    return (
      <div className="min-w-0">
        <Link href={`/clients/${s.matchedClientId}`} className="font-medium text-primary hover:underline">{s.matchedClientName}</Link>
        <div className="text-meta text-muted-foreground">
          Matched by {s.matchedBy === "billing_profile" ? "Stripe customer id" : "email"}
        </div>
      </div>
    );
  }
  if (s.status === "cancelled") {
    return <span className="text-meta">Cancelled and no client to file it under — not imported</span>;
  }
  if (!firstForCustomer) return <span className="text-meta">Same customer as above</span>;
  return (
    <div className="min-w-0 space-y-1">
      <Input
        name={`clientName:${s.customerId}`}
        defaultValue={s.proposedClientName}
        maxLength={200}
        aria-label={`Client name for ${s.customerEmail ?? s.customerId}`}
        className="min-w-48"
      />
      <div className="text-meta text-muted-foreground">Will create this client if its product is ticked</div>
    </div>
  );
}

function subscriptionColumns(firstRowForCustomer: ReadonlySet<string>): readonly DataListColumn<StripeSyncPreviewSubscription>[] {
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
    { key: "client", header: "Client", cell: (s) => <ClientCell s={s} firstForCustomer={firstRowForCustomer.has(s.id)} /> },
    { key: "status", header: "Status", status: true, cell: (s) => <StatusBadge value={s.status} /> },
  ];
}

/** The first subscription row per customer carries the name input; later ones point at it. */
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
  const preview = await previewStripeSync(getDb(), session.organisationId, getPayments());
  const firstRows = firstRowsPerCustomer(preview.subscriptions);
  const suggestedCount = preview.products.filter((p) => p.suggested).length;
  const newClientCount = new Set(preview.subscriptions.filter((s) => s.willCreateClient).map((s) => s.customerId)).size;

  return (
    <>
      <PageHeader
        title="Review Stripe import"
        description="Tick the products that are LaunchFlow packages. Every subscription on a ticked product is filed under its client — matched by Stripe customer id or email, or created with the name shown."
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
            columns={subscriptionColumns(firstRows)}
            getRowKey={(s) => s.id}
            caption="Stripe subscriptions"
            empty={<EmptyState icon={CreditCard}>No subscriptions in Stripe yet.</EmptyState>}
          />
        </Section>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end max-sm:[&>*]:w-full">
          <Button type="submit" disabled={preview.products.length === 0}>Import selected</Button>
        </div>
      </form>
    </>
  );
}
