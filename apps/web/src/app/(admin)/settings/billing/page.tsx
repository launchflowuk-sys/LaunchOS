import { createAdsAdapter, createPaymentsAdapter, vatRateFromEnv } from "@launchos/integrations";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const CARD = "rounded-lg border border-neutral-200 bg-white p-4";
const HEADING = "mb-3 text-sm font-semibold text-neutral-900";

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
    <dl className="space-y-1 text-sm">
      {names.map((name) => {
        const isSet = !!process.env[name];
        return (
          <div key={name} className="flex items-center justify-between gap-4">
            <dt className="font-mono text-xs text-neutral-600">{name}</dt>
            <dd>
              <StatusBadge value={isSet ? "set" : "not set"} tone={isSet ? "success" : "neutral"} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export default async function BillingSettingsPage() {
  await requireAdmin();

  const payments = createPaymentsAdapter(process.env);
  const ads = createAdsAdapter(process.env);
  const vatRate = vatRateFromEnv(process.env);
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  return (
    <>
      <PageHeader title="Billing" description="Which payment and ads adapters this deployment is using." />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={CARD}>
          <h2 className={HEADING}>
            Payments <StatusBadge value={payments.name} tone={payments.name === "stripe" ? "success" : "warn"} />
          </h2>
          <EnvRows names={PAYMENT_VARS} />
          <p className="mt-3 break-all text-xs text-neutral-500">
            Webhook endpoint: <span className="font-mono">{appUrl}/api/webhooks/stripe</span>
          </p>
          <p className="mt-1 text-xs text-neutral-400">
            Stripe is used only when the adapter, the secret key and the webhook secret are all set; anything less
            falls back to the mock rather than failing at boot.
          </p>
        </section>

        <section className={CARD}>
          <h2 className={HEADING}>Tax</h2>
          <p className="text-sm text-neutral-900">
            VAT rate {vatRate}% <span className="font-mono text-xs text-neutral-500">(VAT_RATE)</span>
          </p>
          <p className="mt-1 text-xs text-neutral-400">Applied only while the organisation has a VAT number (Settings → Organisation); an unregistered supplier raises zero-rated invoices.</p>
        </section>

        <section className={CARD}>
          <h2 className={HEADING}>
            Ads <StatusBadge value={ads.name} tone={ads.name === "mock" ? "warn" : "success"} />
          </h2>
          <EnvRows names={ADS_VARS} />
          <p className="mt-3 text-xs text-neutral-400">
            Mock ingest is deterministic; real Google and Meta ingest needs the credentials above.
          </p>
        </section>
      </div>
    </>
  );
}
