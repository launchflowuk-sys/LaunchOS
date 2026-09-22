"use client";

// The pricing subpath, not the `core` barrel: this is a client component and
// recalculates on every tick, so it must not drag the database driver in.
import { comparePricing, LAUNCHFLOW_PACKAGES, MARKET_BASIS, type PricingAnswers } from "@launchos/core/pricing";

/**
 * What this would cost elsewhere, updating as they choose.
 *
 * The argument it makes is not "we are cheaper". It is **"there is no build
 * fee"** — so the zero is the figure with the weight on it, and the agency
 * column is set quietly beside it rather than struck through in red. A
 * comparison that looks like it is shouting reads as a sales tactic; one that
 * just states both numbers lets the reader do the arithmetic and believe it.
 *
 * Shows nothing until something is picked. A price strip on an empty form is
 * a scare tactic, and a £0 against a £0 says nothing at all.
 */

function money(pence: number): string {
  return `£${Math.round(pence / 100).toLocaleString("en-GB")}`;
}

export function PriceCompare({ answers, variant = "strip" }: { answers: PricingAnswers; variant?: "strip" | "full" }) {
  const c = comparePricing(answers);
  const anything = c.marketBuildPence > 0 || c.marketMonthlyPence > 0;
  if (!anything) return null;

  const pkg = LAUNCHFLOW_PACKAGES[c.recommended];

  if (variant === "strip") {
    return (
      <aside
        aria-label="What this would cost"
        className="rounded-2xl border border-[#E3E7ED] bg-[#F7F9FC] p-4"
      >
        <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[#626D80]">
          What you are choosing
        </p>

        <dl className="mt-3 space-y-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[13px] text-[#626D80]">Typical agency</dt>
            <dd className="text-right text-[14px] font-medium tabular-nums text-[#4D5C70]">
              {c.marketBuildPence > 0 ? `${money(c.marketBuildPence)} to build` : "—"}
              {c.marketMonthlyPence > 0 ? (
                <span className="block text-[13px] font-normal text-[#626D80]">
                  + {money(c.marketMonthlyPence)}/month
                </span>
              ) : null}
            </dd>
          </div>

          <div className="flex items-baseline justify-between gap-3 border-t border-[#E3E7ED] pt-2.5">
            <dt className="text-[13px] font-medium text-[#141B29]">With LaunchFlow</dt>
            <dd className="text-right">
              <span className="block text-[18px] font-semibold leading-tight tracking-[-0.01em] text-[#0969CA]">
                £0 to build
              </span>
              {c.launchflowMonthlyPence > 0 ? (
                <span className="block text-[13px] text-[#4D5C70]">
                  {money(c.launchflowMonthlyPence)}/month · {pkg.label}
                </span>
              ) : null}
            </dd>
          </div>
        </dl>

        <p className="mt-3 border-t border-[#E3E7ED] pt-3 text-[12px] leading-relaxed text-[#626D80]">
          You pay nothing until it is built and you have approved it.
        </p>
      </aside>
    );
  }

  return (
    <div className="rounded-3xl border border-[#E3E7ED] bg-white p-6 sm:p-8">
      <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-[#141B29] sm:text-[26px]">
        What you would have paid elsewhere
      </h3>
      <p className="mt-2 max-w-[46ch] text-[15px] leading-relaxed text-[#4D5C70]">
        Based on everything you have told us, here is the same scope two ways.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-[#E3E7ED] bg-[#F7F9FC] p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[#626D80]">Typical agency</p>
          <p className="mt-2 text-[30px] font-semibold leading-none tracking-[-0.025em] tabular-nums text-[#4D5C70]">
            {money(c.marketBuildPence)}
          </p>
          <p className="mt-1 text-[14px] text-[#626D80]">to build, before anything goes live</p>
          {c.marketMonthlyPence > 0 ? (
            <p className="mt-3 border-t border-[#E3E7ED] pt-3 text-[15px] text-[#4D5C70]">
              then <span className="font-medium tabular-nums">{money(c.marketMonthlyPence)}</span> a month
            </p>
          ) : null}
        </div>

        <div className="rounded-2xl border-2 border-[#0969CA] bg-[#EDF5FB] p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[#0757A8]">With LaunchFlow</p>
          <p className="mt-2 text-[30px] font-semibold leading-none tracking-[-0.025em] text-[#0969CA]">£0</p>
          <p className="mt-1 text-[14px] text-[#4D5C70]">to build. Nothing up front, ever.</p>
          {c.launchflowMonthlyPence > 0 ? (
            <p className="mt-3 border-t border-[#CFE0F0] pt-3 text-[15px] text-[#141B29]">
              then <span className="font-semibold tabular-nums">{money(c.launchflowMonthlyPence)}</span> a month
              <span className="block text-[13px] text-[#4D5C70]">
                {pkg.label} — cancel any time, 30 days&rsquo; notice
              </span>
            </p>
          ) : null}
        </div>
      </div>

      {c.firstYearSavingPence > 0 ? (
        <p className="mt-5 rounded-2xl bg-[#141B29] px-5 py-4 text-[16px] leading-relaxed text-white">
          That is{" "}
          <span className="font-semibold tabular-nums">{money(c.firstYearSavingPence)}</span> less in your first
          year — and you do not pay a penny until your site is built, you have seen it, and you have said yes.
        </p>
      ) : null}

      {c.buildItems.length > 0 ? (
        <details className="mt-5 border-t border-[#E3E7ED] pt-4">
          <summary className="cursor-pointer text-[14px] font-medium text-[#0969CA]">
            See how the agency figure is made up
          </summary>
          <ul className="mt-3 space-y-1.5">
            {c.buildItems.map((item) => (
              <li key={item.label} className="flex justify-between gap-4 text-[14px] text-[#4D5C70]">
                <span>{item.label}</span>
                <span className="tabular-nums">{money(item.pence)}</span>
              </li>
            ))}
            {c.ongoingItems.map((item) => (
              <li key={item.label} className="flex justify-between gap-4 text-[14px] text-[#4D5C70]">
                <span>{item.label}</span>
                <span className="tabular-nums">{money(item.pence)}/mo</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="mt-4 text-[12px] leading-relaxed text-[#8A94A6]">{MARKET_BASIS}</p>
    </div>
  );
}
