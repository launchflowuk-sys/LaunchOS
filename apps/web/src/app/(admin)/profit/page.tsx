import { profitReport } from "@launchos/core";
import { Info, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export const metadata = { title: "Profit" };

/**
 * What the company made this month, and what it spent to make it.
 *
 * **Ex-VAT, with the gross beside it.** VAT charged is not income and VAT paid
 * is reclaimable, so a margin computed on gross figures is wrong; the gross is
 * kept alongside so a figure here can be matched against the bank.
 *
 * The screen states, prominently and permanently until it is untrue, that the
 * variable costs are not in it. A margin that silently omits the AI, image and
 * message spend is worse than no margin: it is a number somebody will quote.
 */

function gbp(pence: number): string {
  const sign = pence < 0 ? "−" : "";
  return `${sign}£${(Math.abs(pence) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const VAT_LABEL: Record<string, string> = {
  standard: "UK VAT",
  reverse_charge: "Reverse charge",
  exempt: "Exempt",
  none: "No VAT",
};

export default async function ProfitPage() {
  const session = await requireAdmin();
  const report = await profitReport(getDb(), session.organisationId);

  const monthLabel = new Date(`${report.month}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const positive = report.marginNetPence >= 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Profit"
        description={`Revenue collected against what the company pays out. ${monthLabel}, ex-VAT.`}
      />

      {/* Not a dismissible toast: it is true until the usage ledger is built,
          and the figures below are wrong without it being read. */}
      <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">These figures are incomplete.</p>
          <p className="mt-1">
            Only the cost register is counted — subscriptions and fixed costs. Not counted yet:{" "}
            {report.excludes.join(", ")}. The usage ledger that meters those is not built, so the margin below is
            better than reality by whatever they come to.
          </p>
          {report.unpricedCount > 0 ? (
            <p className="mt-1">
              <Link href="/settings/costs" className="underline">
                {report.unpricedCount} register {report.unpricedCount === 1 ? "line has" : "lines have"} no price
              </Link>{" "}
              and {report.unpricedCount === 1 ? "counts" : "count"} as zero.
            </p>
          ) : null}
          {report.missingRateCurrencies.length > 0 ? (
            <p className="mt-1">
              No exchange rate for {report.missingRateCurrencies.join(", ")} — those rows are excluded entirely rather
              than converted at a guess.{" "}
              <Link href="/settings/costs" className="underline">
                Set a rate
              </Link>
              .
            </p>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Revenue collected"
          value={gbp(report.revenueNetPence)}
          hint={`${gbp(report.revenueGrossPence)} inc. VAT`}
          icon={TrendingUp}
        />
        <StatCard
          label="Cost (register only)"
          value={gbp(report.costNetPence)}
          hint={`${gbp(report.costGrossPence)} inc. VAT`}
          icon={Wallet}
        />
        <StatCard
          label="Margin this month"
          value={gbp(report.marginNetPence)}
          hint={positive ? "Revenue exceeds register cost" : "Register cost exceeds revenue"}
          icon={positive ? TrendingUp : TrendingDown}
        />
        <StatCard
          label="Annualised cost"
          value={gbp(report.yearlyCostNetPence)}
          hint={`${gbp(report.yearlyRevenueNetPence)} revenue, rolling 12 months`}
          icon={Wallet}
        />
      </div>

      {report.costByBusiness.length > 0 ? (
        <Section
          title="Cost by business"
          description="Which business each bill belongs to. Mapbox is Cabio's, not LaunchFlow's — without this split the taxi platform's mapping bill lands on LaunchFlow's margin."
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-slate-500">
                  <th className="pb-2 font-medium">Business</th>
                  <th className="pb-2 text-right font-medium">Per month</th>
                  <th className="pb-2 text-right font-medium">Per year</th>
                </tr>
              </thead>
              <tbody>
                {report.costByBusiness.map((line) => (
                  <tr key={line.business} className="border-t border-slate-100">
                    <td className="py-2 text-slate-900">{line.label}</td>
                    <td className="py-2 text-right tabular-nums text-slate-900">{gbp(line.monthlyNetPence)}</td>
                    <td className="py-2 text-right tabular-nums text-slate-500">{gbp(line.monthlyNetPence * 12)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      <Section
        title="Every cost"
        description="Normalised to a month in GBP, ex-VAT, at the rate stored for the first of this month — so a closed month never changes."
        actions={
          <Link href="/settings/costs" className="text-sm text-slate-600 underline">
            Edit the register
          </Link>
        }
      >
        {report.lines.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing in the register yet.{" "}
            <Link href="/settings/costs" className="underline">
              Add the suppliers the code already knows about
            </Link>{" "}
            and correct the prices.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-slate-500">
                  <th className="pb-2 font-medium">Cost</th>
                  <th className="pb-2 font-medium">Business</th>
                  <th className="pb-2 font-medium">VAT</th>
                  <th className="pb-2 text-right font-medium">Per month</th>
                  <th className="pb-2 text-right font-medium">Inc. VAT</th>
                  <th className="pb-2 text-right font-medium">Per year</th>
                </tr>
              </thead>
              <tbody>
                {report.lines.map((line) => (
                  <tr key={`${line.supplier}-${line.name}`} className="border-t border-slate-100">
                    <td className="py-2">
                      <span className="text-slate-900">{line.name}</span>
                      <span className="ml-2 text-xs text-slate-400">{line.supplier}</span>
                      {line.rateMissing ? (
                        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                          no {line.currencyCode} rate
                        </span>
                      ) : null}
                      {line.unpriced ? (
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                          no price set
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 text-slate-600">{line.businessLabel}</td>
                    <td className="py-2 text-xs text-slate-500">{VAT_LABEL[line.vatTreatment] ?? line.vatTreatment}</td>
                    <td className="py-2 text-right tabular-nums text-slate-900">{gbp(line.monthlyNetPence)}</td>
                    <td className="py-2 text-right tabular-nums text-slate-500">{gbp(line.monthlyGrossPence)}</td>
                    <td className="py-2 text-right tabular-nums text-slate-500">{gbp(line.yearlyNetPence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
