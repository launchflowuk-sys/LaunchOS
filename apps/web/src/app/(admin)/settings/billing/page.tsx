import { getStripeSyncSettings } from "@launchos/core";
import { ADS_ENV_KEYS, createAdsAdapterFromEnv, createPaymentsAdapter, vatRateFromEnv } from "@launchos/integrations";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { syncStripeNowAction } from "./stripe/actions";
import { RESULT_PATH, REVIEW_PATH } from "./stripe/paths";

export const dynamic = "force-dynamic";

const PAYMENT_VARS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PUBLISHABLE_KEY"] as const;
/**
 * The keys the ads factory actually reads, from the factory's own list, so
 * this screen cannot show "set" for a variable no adapter looks at. Per-account
 * ids are not env — they are `ad_accounts.external_id`.
 */
const ADS_VARS = [...ADS_ENV_KEYS.google, ...ADS_ENV_KEYS.meta] as const;

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
  const session = await requireAdmin();

  const payments = createPaymentsAdapter(process.env);
  const stripeSync = await getStripeSyncSettings(getDb(), session.organisationId);
  const last = stripeSync.lastSummary;
  const ads = createAdsAdapterFromEnv(process.env);
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
          <h2 className="text-base font-semibold">Stripe catalogue</h2>
          {last ? (
            <p className="mt-3 text-sm">
              Last run {formatDateTime(last.at)}
              <span className="text-muted-foreground"> ({last.trigger === "import" ? "import" : last.trigger === "reconcile" ? "sync" : "webhook"})</span>:{" "}
              <span className="tabular-nums">{last.clients.created.length}</span> client{last.clients.created.length === 1 ? "" : "s"} created,{" "}
              {last.clients.filed.length > 0 ? <><span className="tabular-nums">{last.clients.filed.length}</span> filed under existing,{" "}</> : null}
              <span className="tabular-nums">{last.subscriptions.created}</span> subscription{last.subscriptions.created === 1 ? "" : "s"} imported,{" "}
              <span className="tabular-nums">{last.subscriptions.updated}</span> updated
              {last.statusChanges.length > 0 ? <>, <span className="tabular-nums">{last.statusChanges.length}</span> status change{last.statusChanges.length === 1 ? "" : "s"}</> : null}.{" "}
              <Link href={RESULT_PATH} className="font-medium text-primary hover:underline">See the result</Link>
            </p>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Never synced. Pull the products and subscriptions from Stripe and have them assigned to clients — new clients are created for customers LaunchOS has not seen.
            </p>
          )}
          <p className="mt-1.5 text-meta text-muted-foreground">
            The review shows what would change before anything is written. After the first import, a nightly sync at 04:10 (and every
            Stripe subscription webhook) keeps clients, packages and subscriptions in step; &ldquo;Sync now&rdquo; runs the same pass.
            {stripeSync.ignoredProductIds.length > 0 ? ` ${stripeSync.ignoredProductIds.length} product${stripeSync.ignoredProductIds.length === 1 ? "" : "s"} left out.` : ""}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap max-sm:[&>*]:w-full">
            <Button asChild>
              <Link href={REVIEW_PATH}>Review Stripe import</Link>
            </Button>
            <ActionForm action={syncStripeNowAction} ariaLabel="Sync Stripe now" success="Stripe sync finished" className="contents">
              <Button type="submit" variant="secondary" disabled={!last}>Sync now</Button>
            </ActionForm>
          </div>
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
            Each platform goes live on its own once all of its keys are set (Google needs all five, Meta both);
            &ldquo;multi&rdquo; means both are. Mock ingest is deterministic.
          </p>
        </Panel>
      </div>
    </>
  );
}
