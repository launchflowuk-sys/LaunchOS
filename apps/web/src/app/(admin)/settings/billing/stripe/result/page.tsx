import { getStripeSyncSettings } from "@launchos/core";
import { CreditCard } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdminWith } from "@/lib/permissions";
import { REVIEW_PATH } from "../paths";

export const dynamic = "force-dynamic";

const TRIGGER_LABEL = { import: "Import", reconcile: "Sync", webhook: "Stripe webhook" } as const;

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-figure font-semibold tabular-nums">{value}</div>
      <div className="label-caps mt-1 text-muted-foreground">{label}</div>
    </div>
  );
}

function NamedList({ rows, href, emptyText }: { rows: readonly { id: string; name: string }[]; href: (id: string) => string; emptyText: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {rows.map((row) => (
        <li key={row.id} className="px-4 py-2.5 text-sm">
          <Link href={href(row.id)} className="font-medium text-primary hover:underline">{row.name}</Link>
        </li>
      ))}
    </ul>
  );
}

export default async function StripeResultPage() {
  const session = await requireAdminWith("settings");
  const settings = await getStripeSyncSettings(getDb(), session.organisationId);
  const summary = settings.lastSummary;

  const actions = (
    <>
      <Button asChild variant="secondary"><Link href={REVIEW_PATH}>Review again</Link></Button>
      <Button asChild><Link href="/settings/billing">Back to Billing</Link></Button>
    </>
  );

  if (!summary) {
    return (
      <>
        <PageHeader title="Stripe import" description="Nothing has been imported yet." category="organisation" actions={actions} />
        <EmptyState icon={CreditCard}>Run the review first — it shows what would be imported before anything is written.</EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Stripe import"
        description={`${TRIGGER_LABEL[summary.trigger]} finished ${formatDateTime(summary.at)}.`}
        category="organisation"
        actions={actions}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Packages created" value={summary.packages.created.length} />
        <Stat label="Clients created" value={summary.clients.created.length} />
        <Stat label="Subscriptions imported" value={summary.subscriptions.created} />
        <Stat label="Subscriptions updated" value={summary.subscriptions.updated} />
      </div>
      <p className="mt-3 text-meta text-muted-foreground">
        {summary.clients.matched} existing client{summary.clients.matched === 1 ? "" : "s"} matched, {summary.subscriptions.unchanged} subscription
        {summary.subscriptions.unchanged === 1 ? "" : "s"} already up to date, {summary.subscriptions.skipped} skipped (cancelled with no client to file under).
      </p>

      <Section title="Clients created" description="Named from Stripe or from what you typed on the review. Check each one and add a portal login when you are ready.">
        <NamedList rows={summary.clients.created} href={(id) => `/clients/${id}`} emptyText="No new clients this run." />
      </Section>

      <Section title="Packages" description="Created from the ticked products, or existing packages that gained their Stripe link.">
        <NamedList
          rows={[...summary.packages.created, ...summary.packages.linked]}
          href={() => "/settings/packages"}
          emptyText="No packages created or linked this run."
        />
      </Section>

      <Section title="Status changes" description="Subscriptions whose status moved since the last run.">
        {summary.statusChanges.length === 0 ? (
          <p className="text-sm text-muted-foreground">No status changes.</p>
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {summary.statusChanges.map((change) => (
              <li key={change.subscriptionId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <Link href={`/clients/${change.clientId}/billing`} className="font-medium text-primary hover:underline">{change.clientName}</Link>
                <span className="text-muted-foreground">{change.from.replace("_", " ")} → {change.to.replace("_", " ")}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
