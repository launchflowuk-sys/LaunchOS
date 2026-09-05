import { createAdsAdapter, createPaymentsAdapter, vatRateFromEnv } from "@launchos/integrations";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const PAYMENT_VARS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PUBLISHABLE_KEY"] as const;
const ADS_VARS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CUSTOMER_ID",
  "META_ADS_ACCESS_TOKEN",
  "META_ADS_AD_ACCOUNT_ID",
] as const;

/**
 * Whether a secret is present — never its value. Reading these on the server
 * and rendering only "set" / "not set" keeps the page safe to screenshot.
 */
function EnvRows({ names }: { names: readonly string[] }) {
  return (
    <dl className="mt-3 divide-y rounded-lg border">
      {names.map((name) => {
        const isSet = !!process.env[name];
        return (
          <div key={name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <dt className="min-w-0 font-mono text-meta break-all text-muted-foreground">{name}</dt>
            <dd className="shrink-0">
              <StatusBadge value={isSet ? "set" : "not set"} tone={isSet ? "success" : "neutral"} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return <section className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">{children}</section>;
}

export default async function BillingSettingsPage() {
  await requireAdmin();

  const payments = createPaymentsAdapter(process.env);
  const ads = createAdsAdapter(process.env);
  const vatRate = vatRateFromEnv(process.env);
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  return (
    <>
      <PageHeader
        title="Billing"
        description="Which payment and ads adapters this deployment is using."
        category="organisation"
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            Payments <StatusBadge value={payments.name} tone={payments.name === "stripe" ? "success" : "warn"} />
          </h2>
          <EnvRows names={PAYMENT_VARS} />
          <p className="mt-3 text-meta break-all text-muted-foreground">
            Webhook endpoint: <span className="font-mono">{appUrl}/api/webhooks/stripe</span>
          </p>
          <p className="mt-1.5 text-meta text-muted-foreground">
            Stripe is used only when the adapter, the secret key and the webhook secret are all set; anything less
            falls back to the mock rather than failing at boot.
          </p>
        </Panel>

        <Panel>
          <h2 className="text-base font-semibold">Tax</h2>
          <p className="mt-3 text-sm">
            VAT rate <span className="font-medium tabular-nums">{vatRate}%</span>{" "}
            <span className="font-mono text-meta text-muted-foreground">(VAT_RATE)</span>
          </p>
          <p className="mt-1.5 text-meta text-muted-foreground">
            Applied only while the organisation has a VAT number (Settings → Organisation); an unregistered supplier
            raises zero-rated invoices.
          </p>
        </Panel>

        <Panel>
          <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            Ads <StatusBadge value={ads.name} tone={ads.name === "mock" ? "warn" : "success"} />
          </h2>
          <EnvRows names={ADS_VARS} />
          <p className="mt-3 text-meta text-muted-foreground">
            Mock ingest is deterministic; real Google and Meta ingest needs the credentials above.
          </p>
        </Panel>
      </div>
    </>
  );
}
