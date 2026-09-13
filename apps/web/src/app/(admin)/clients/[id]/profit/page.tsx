import { clientProfit, getClient } from "@launchos/core";
import { Info } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { ClientTabs } from "../tabs";

export const dynamic = "force-dynamic";

/**
 * What this client is worth, this month.
 *
 * The number nobody could answer before: revenue was always visible and cost
 * never was, so "this client brings in £950" was as far as it went.
 *
 * Four lines, and the last is the one worth reading twice. Their **share of
 * shared cost** is split by measured usage rather than evenly — a client who
 * generates forty images a month leans on the server harder than one with a
 * static page, and an even split would flatter the expensive one at the cheap
 * one's expense. When nothing is metered at all it falls back to even, because
 * dividing by zero usage would land the whole server bill on whoever came
 * first alphabetically.
 */

function gbp(pence: number): string {
  const sign = pence < 0 ? "−" : "";
  return `${sign}£${(Math.abs(pence) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function ClientProfitPage({ params }: PageProps<"/clients/[id]/profit">) {
  const session = await requireAdmin();
  const clientId = uuidOr404((await params).id);
  const db = getDb();

  const client = await getClient(db, session.organisationId, clientId);
  if (!client) notFound();

  const profit = await clientProfit(db, session.organisationId, clientId);
  const monthLabel = new Date(`${profit.month}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={client.name} description={`Profit for ${monthLabel}, ex-VAT.`} />
      <ClientTabs clientId={clientId} active="profit" />

      <div className="flex gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <p>
            Revenue is what they actually paid this month, not what they were billed. Cost is their own register lines,
            plus the metered calls made for them, plus their slice of the costs nobody can attribute.
          </p>
          <p className="mt-1">
            {profit.sharedSplitEven ? (
              <>
                Shared costs are split <strong>evenly</strong> this month, because nothing has been metered against any
                client yet. Once usage is flowing the split follows it.
              </>
            ) : (
              <>
                Shared costs are split by measured usage. This client accounts for{" "}
                <strong>{(profit.usageShare * 100).toFixed(1)}%</strong> of all metered usage.
              </>
            )}
          </p>
          {profit.missingRateCurrencies.length > 0 ? (
            <p className="mt-1">
              Direct cost is understated: no exchange rate for {profit.missingRateCurrencies.join(", ")}.{" "}
              <Link href="/settings/costs" className="underline">
                Set one
              </Link>
              .
            </p>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Revenue collected" value={gbp(profit.revenueNetPence)} hint="Paid invoices this month" />
        <StatCard label="Total cost" value={gbp(profit.totalCostPence)} hint="Direct + usage + shared" />
        <StatCard
          label="Margin"
          value={gbp(profit.marginPence)}
          hint={profit.marginPence >= 0 ? "In profit this month" : "Costing more than they pay"}
        />
        <StatCard label="Metered usage" value={gbp(profit.usageCostPence)} hint="Calls made for this client" />
      </div>

      <Section title="The breakdown" description="Where the cost comes from.">
        <table className="w-full max-w-[560px] border-collapse text-left text-sm">
          <tbody>
            <tr className="border-t border-slate-100">
              <td className="py-2 text-slate-700">Revenue collected</td>
              <td className="py-2 text-right tabular-nums text-slate-900">{gbp(profit.revenueNetPence)}</td>
            </tr>
            <tr className="border-t border-slate-100">
              <td className="py-2 text-slate-700">Direct cost — their domains and hosting</td>
              <td className="py-2 text-right tabular-nums text-slate-900">−{gbp(profit.directCostPence)}</td>
            </tr>
            <tr className="border-t border-slate-100">
              <td className="py-2 text-slate-700">Metered usage — images, tokens, emails</td>
              <td className="py-2 text-right tabular-nums text-slate-900">−{gbp(profit.usageCostPence)}</td>
            </tr>
            <tr className="border-t border-slate-100">
              <td className="py-2 text-slate-700">
                Share of shared cost — servers, tooling
                {profit.sharedSplitEven ? <span className="ml-2 text-xs text-slate-400">split evenly</span> : null}
              </td>
              <td className="py-2 text-right tabular-nums text-slate-900">−{gbp(profit.sharedCostPence)}</td>
            </tr>
            <tr className="border-t-2 border-slate-300">
              <td className="py-2 font-medium text-slate-900">Margin</td>
              <td className="py-2 text-right font-medium tabular-nums text-slate-900">{gbp(profit.marginPence)}</td>
            </tr>
          </tbody>
        </table>
      </Section>
    </div>
  );
}
