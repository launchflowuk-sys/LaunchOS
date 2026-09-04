import { computeAccountSignals, type SignalWindow } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Sparkline } from "@/components/sparkline";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDate, formatMoney } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { editAdAccount } from "../actions";

export const dynamic = "force-dynamic";

const CARD = "rounded-lg border border-neutral-200 bg-white p-4";
const HEADING = "mb-2 text-sm font-semibold text-neutral-900";
const FIELD = "mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900";
const LABEL = "block text-xs font-medium text-neutral-500";
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
    <section className={CARD}>
      <h2 className={HEADING}>{title}</h2>
      <p className="mb-3 text-xs text-neutral-400">
        {w.from} to {w.to} · {w.days} {w.days === 1 ? "day" : "days"} of data
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {stats.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-neutral-500">{label}</dt>
            <dd className="text-right tabular-nums text-neutral-900">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
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
        actions={<StatusBadge value={account.status} />}
      />

      <p className="mb-6 text-sm text-neutral-500">
        <Link href="/ads" className="underline">
          All ad accounts
        </Link>{" "}
        ·{" "}
        <Link href={`/clients/${account.clientId}`} className="underline">
          {account.clientName}
        </Link>
      </p>

      {/*
        The platform and the external id are the account's identity — the key
        the ingest matches on — so they are not editable; a wrong one is a new
        account. The currency is why this form exists: before it, a mistyped
        code could only be fixed with an UPDATE against production Postgres.
      */}
      <details className="mb-6 rounded-lg border border-neutral-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold text-neutral-900">Edit account</summary>
        <ActionForm
          action={editAdAccount}
          ariaLabel="Edit ad account"
          success="Ad account updated"
          className="mt-3 space-y-3"
        >
          <input type="hidden" name="adAccountId" value={account.id} />
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={LABEL}>
              Account name
              <input name="name" required maxLength={200} defaultValue={account.name} className={FIELD} />
            </label>
            <label className={LABEL}>
              Currency
              <input
                name="currency"
                required
                maxLength={3}
                pattern="[A-Za-z]{3}"
                title="A three-letter currency code, such as GBP"
                defaultValue={account.currency}
                className={FIELD}
              />
            </label>
            <label className={LABEL}>
              Status
              <select name="status" defaultValue={account.status} className={FIELD}>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="disconnected">Disconnected</option>
              </select>
            </label>
          </div>
          <div className="flex justify-end">
            <Button type="submit">Save changes</Button>
          </div>
        </ActionForm>
      </details>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <WindowCard title="Last 7 days" window={signals.current} currency={account.currency} />
        <WindowCard title="Previous 7 days" window={signals.previous} currency={account.currency} />
        <section className={CARD}>
          <h2 className={HEADING}>Signals</h2>
          {signals.flagged ? (
            <ul className="list-disc space-y-1 pl-4 text-sm text-red-700">
              {signals.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">No signals — this account is steady.</p>
          )}
        </section>
      </div>

      {oldestFirst.length === 0 ? (
        <EmptyState>No daily metrics yet. The ads ingest job writes one snapshot per account per day.</EmptyState>
      ) : (
        <>
          <div className="mb-6 grid gap-4 lg:grid-cols-3">
            <section className={CARD}>
              <h2 className={HEADING}>ROAS, last 30 days</h2>
              <Sparkline values={oldestFirst.map((s) => s.roas)} label="ROAS, last 30 days" />
            </section>
            <section className={CARD}>
              <h2 className={HEADING}>Spend, last 30 days</h2>
              <Sparkline values={oldestFirst.map((s) => s.spendPence)} label="Spend, last 30 days" />
            </section>
            <section className={CARD}>
              <h2 className={HEADING}>Clicks, last 30 days</h2>
              <Sparkline values={oldestFirst.map((s) => s.clicks)} label="Clicks, last 30 days" />
            </section>
          </div>

          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Impressions</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">Conversions</TableHead>
                  <TableHead className="text-right">CPC</TableHead>
                  <TableHead className="text-right">ROAS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {newestFirst.map((snapshot) => (
                  <TableRow key={snapshot.id}>
                    <TableCell className="whitespace-nowrap text-neutral-600">{formatDate(snapshot.date)}</TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-900">
                      {formatMoney(snapshot.spendPence, account.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-600">
                      {snapshot.impressions.toLocaleString("en-GB")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-600">
                      {snapshot.clicks.toLocaleString("en-GB")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-600">
                      {snapshot.conversions.toLocaleString("en-GB")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-600">
                      {formatMoney(Math.round(snapshot.cpcPence), account.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-900">
                      {snapshot.roas.toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </>
  );
}
