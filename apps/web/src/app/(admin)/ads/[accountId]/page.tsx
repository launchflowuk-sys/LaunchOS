import { computeAccountSignals, type SignalWindow } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ChartColumn } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { DataList, type DataListColumn } from "@/components/data-list";
import { NativeSelect } from "@/components/ui/native-select";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Sparkline } from "@/components/sparkline";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getDb } from "@/lib/db";
import { formatDate, formatMoney } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { editAdAccount } from "../actions";

export const dynamic = "force-dynamic";

const SNAPSHOT_DAYS = 30;

function WindowCard({ title, window: w, currency }: { title: string; window: SignalWindow; currency: string }) {
  const stats = [
    ["Spend", formatMoney(w.spendPence, currency)],
    ["Clicks", w.clicks.toLocaleString("en-GB")],
    ["Conversions", w.conversions.toLocaleString("en-GB")],
    ["ROAS", w.roas.toFixed(2)],
    ["CPC", formatMoney(Math.round(w.cpcPence), currency)],
  ] as const;

  return (
    <section className="min-w-0 rounded-xl border bg-card p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-meta text-muted-foreground">
        {w.from} to {w.to} · {w.days} {w.days === 1 ? "day" : "days"} of data
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-row">
        {stats.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

type Snapshot = typeof schema.adMetricSnapshots.$inferSelect;

function snapshotColumns(currency: string): readonly DataListColumn<Snapshot>[] {
  const count = (n: number) => n.toLocaleString("en-GB");
  return [
    { key: "date", header: "Date", primary: true, cell: (s) => <span className="whitespace-nowrap">{formatDate(s.date)}</span> },
    {
      key: "spend",
      header: "Spend",
      numeric: true,
      className: "font-medium text-foreground",
      cell: (s) => formatMoney(s.spendPence, currency),
    },
    { key: "impressions", header: "Impressions", numeric: true, hideOnMobile: true, cell: (s) => count(s.impressions) },
    { key: "clicks", header: "Clicks", numeric: true, cell: (s) => count(s.clicks) },
    { key: "conversions", header: "Conversions", numeric: true, cell: (s) => count(s.conversions) },
    { key: "cpc", header: "CPC", numeric: true, cell: (s) => formatMoney(Math.round(s.cpcPence), currency) },
    { key: "roas", header: "ROAS", numeric: true, className: "font-medium text-foreground", cell: (s) => s.roas.toFixed(2) },
  ];
}

export default async function AdAccountPage({ params }: PageProps<"/ads/[accountId]">) {
  const session = await requireAdmin();
  // A malformed segment (`/ads/new`, `/ads/undefined`) is a 404, not the 22P02
  // Postgres raises when a non-UUID literal reaches a `uuid` column.
  const accountId = uuidOr404((await params).accountId);
  const db = getDb();

  const [account] = await db
    .select({
      id: schema.adAccounts.id,
      clientId: schema.adAccounts.clientId,
      clientName: schema.clients.name,
      platform: schema.adAccounts.platform,
      externalId: schema.adAccounts.externalId,
      name: schema.adAccounts.name,
      currency: schema.adAccounts.currency,
      status: schema.adAccounts.status,
    })
    .from(schema.adAccounts)
    .innerJoin(schema.clients, eq(schema.adAccounts.clientId, schema.clients.id))
    .where(
      and(
        eq(schema.adAccounts.id, accountId),
        eq(schema.adAccounts.organisationId, session.organisationId),
        isNull(schema.adAccounts.deletedAt),
      ),
    );
  if (!account) notFound();

  const [signals, newestFirst] = await Promise.all([
    computeAccountSignals(db, session.organisationId, account.id, { now: new Date() }),
    db
      .select()
      .from(schema.adMetricSnapshots)
      .where(
        and(
          eq(schema.adMetricSnapshots.organisationId, session.organisationId),
          eq(schema.adMetricSnapshots.adAccountId, account.id),
        ),
      )
      .orderBy(desc(schema.adMetricSnapshots.date))
      .limit(SNAPSHOT_DAYS),
  ]);

  // The table reads newest first; the charts read left to right, oldest first.
  const oldestFirst = [...newestFirst].reverse();

  return (
    <>
      <PageHeader
        title={account.name}
        description={`${account.platform === "google" ? "Google" : "Meta"} · ${account.externalId} · ${account.clientName}`}
        category="money"
        // Wrapped: PageHeader stretches its actions under `sm`, and a pill
        // that fills the width reads as a button, not a state.
        actions={
          <div>
            <StatusBadge value={account.status} />
          </div>
        }
      />

      <p className="mb-6 text-sm text-muted-foreground">
        <Link href="/ads" className="underline hover:text-foreground">
          All ad accounts
        </Link>{" "}
        ·{" "}
        <Link href={`/clients/${account.clientId}`} className="underline hover:text-foreground">
          {account.clientName}
        </Link>
      </p>

      {/*
        The platform and the external id are the account's identity — the key
        the ingest matches on — so they are not editable; a wrong one is a new
        account. The currency is why this form exists: before it, a mistyped
        code could only be fixed with an UPDATE against production Postgres.
      */}
      <details className="mb-8 rounded-xl border bg-card p-4">
        <summary className="cursor-pointer text-sm font-medium">Edit account</summary>
        <ActionForm
          action={editAdAccount}
          ariaLabel="Edit ad account"
          success="Ad account updated"
          className="mt-4 space-y-4"
        >
          <input type="hidden" name="adAccountId" value={account.id} />
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="ad-account-name">Account name</Label>
              <Input id="ad-account-name" name="name" required maxLength={200} defaultValue={account.name} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-account-currency">Currency</Label>
              <Input
                id="ad-account-currency"
                name="currency"
                required
                maxLength={3}
                pattern="[A-Za-z]{3}"
                title="A three-letter currency code, such as GBP"
                defaultValue={account.currency}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-account-status">Status</Label>
              <NativeSelect key={account.status} id="ad-account-status" name="status" defaultValue={account.status}>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="disconnected">Disconnected</option>
              </NativeSelect>
            </div>
          </div>
          <div className="flex justify-end max-sm:[&>*]:w-full">
            <Button type="submit">Save changes</Button>
          </div>
        </ActionForm>
      </details>

      <div className="grid gap-4 lg:grid-cols-3">
        <WindowCard title="Last 7 days" window={signals.current} currency={account.currency} />
        <WindowCard title="Previous 7 days" window={signals.previous} currency={account.currency} />
        <section className="min-w-0 rounded-xl border bg-card p-4">
          <h2 className="text-base font-semibold">Signals</h2>
          {signals.flagged ? (
            <ul className="mt-3 list-disc space-y-1 pl-4 text-sm text-danger-fg">
              {signals.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No signals — this account is steady.</p>
          )}
        </section>
      </div>

      {oldestFirst.length === 0 ? (
        <Section title="Daily metrics">
          <EmptyState icon={ChartColumn}>
            No daily metrics yet. The ads ingest job writes one snapshot per account per day.
          </EmptyState>
        </Section>
      ) : (
        <>
          <Section title="Last 30 days">
            <div className="grid gap-4 lg:grid-cols-3">
              {(
                [
                  ["ROAS", oldestFirst.map((s) => s.roas)],
                  ["Spend", oldestFirst.map((s) => s.spendPence)],
                  ["Clicks", oldestFirst.map((s) => s.clicks)],
                ] as const
              ).map(([label, values]) => (
                <section key={label} className="min-w-0 overflow-hidden rounded-xl border bg-card p-4">
                  <h3 className="label-caps text-muted-foreground">{label}</h3>
                  <div className="mt-2">
                    <Sparkline values={[...values]} label={`${label}, last 30 days`} />
                  </div>
                </section>
              ))}
            </div>
          </Section>

          <Section title="Daily metrics">
            <DataList
              rows={newestFirst}
              columns={snapshotColumns(account.currency)}
              getRowKey={(snapshot) => snapshot.id}
              caption="Daily ad metrics"
            />
          </Section>
        </>
      )}
    </>
  );
}
