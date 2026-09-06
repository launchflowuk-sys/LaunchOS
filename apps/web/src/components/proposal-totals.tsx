import { formatPence } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The three figures a proposal actually turns on.
 *
 * They are **derived**, never typed in: core sums the lines of each kind and
 * rewrites them on every line change, so there is no state where the headline
 * says £250 a month and the schedule underneath says something else. That is
 * why this component takes numbers and renders them and has no input in it.
 *
 * Which of the three matters depends on the shape, and all three are shown
 * anyway — a zero is information here. "Nothing to pay today" is the whole
 * selling point of the monthly-on-delivery shape, and it only reads as a
 * promise if the row it sits in is the row that would otherwise carry a fee.
 */
export type ProposalFigures = {
  dueOnAcceptancePence: number;
  recurringMonthlyPence: number;
  firstYearPence: number;
};

const FIGURES: readonly { key: keyof ProposalFigures; label: string; suffix?: string; zero?: string }[] = [
  { key: "dueOnAcceptancePence", label: "Due on acceptance", zero: "Nothing to pay today" },
  { key: "recurringMonthlyPence", label: "Every month", suffix: "a month", zero: "Nothing recurring" },
  { key: "firstYearPence", label: "First year, in total" },
];

export function ProposalTotals({
  totals,
  description,
  vatNote,
  className,
}: {
  totals: ProposalFigures;
  /** Core's one-sentence `describePricing`, computed on the server. */
  description?: string;
  vatNote?: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border bg-card", className)}>
      <dl className="grid gap-px overflow-hidden rounded-xl bg-border sm:grid-cols-3">
        {FIGURES.map((figure) => {
          const pence = totals[figure.key];
          return (
            <div key={figure.key} className="bg-card p-4">
              <dt className="label-caps text-muted-foreground">{figure.label}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">
                {pence === 0 && figure.zero ? (
                  <span className="text-base font-medium text-muted-foreground">{figure.zero}</span>
                ) : (
                  <>
                    {formatPence(pence)}
                    {figure.suffix ? <span className="text-sm font-normal text-muted-foreground"> {figure.suffix}</span> : null}
                  </>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {description || vatNote ? (
        <div className="border-t px-4 py-3">
          {description ? <p className="text-sm">{description}</p> : null}
          {vatNote ? <p className="mt-1 text-meta text-muted-foreground">{vatNote}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
