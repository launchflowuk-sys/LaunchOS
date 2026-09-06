import type { ProposalDetail } from "@launchos/core";
import type { ProposalLineKind } from "@launchos/db/schema";
import { formatPence } from "@/lib/format";

/**
 * The proposal as a client reads it on a phone: what we will do, what it
 * costs, when, what is not included, and the terms.
 *
 * Deliberately **not** the PDF in an iframe. The PDF is A4 and is what they
 * keep; this is the same content laid out for a 390px screen, in one column,
 * in the order somebody actually decides in — the work, then the money, then
 * the small print.
 *
 * The price is broken out by shape rather than reduced to one number, because
 * the difference between the three shapes is a promise about *when*: "£250 a
 * month, nothing today" and "£3,000" can be the same year and are not the same
 * offer. The figures come from core and are derived from the lines.
 */

const LINE_KIND_LABEL: Record<ProposalLineKind, string> = {
  setup: "One-off, to start",
  monthly: "Every month",
  one_off: "One-off",
};

/** What the client pays first, first — the same order the document prints. */
const LINE_KIND_ORDER: readonly ProposalLineKind[] = ["setup", "one_off", "monthly"];

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => (
          <p key={block.slice(0, 40)} className="body mt-3 whitespace-pre-line">
            {block}
          </p>
        ))}
    </>
  );
}

export function ProposalBody({ detail, description }: { detail: ProposalDetail; description: string }) {
  const { proposal, lines, totals } = detail;
  const { deliverables, outOfScope, timeline } = proposal.scope;

  const figures = [
    { label: "Due on acceptance", pence: totals.dueOnAcceptancePence, zero: "Nothing to pay today" },
    { label: "Every month", pence: totals.recurringMonthlyPence, zero: "Nothing recurring", suffix: "a month" },
    { label: "First year, in total", pence: totals.firstYearPence },
  ];

  return (
    <div className="grid gap-10">
      {proposal.summary ? (
        <section>
          <h2 className="h-sub">In short</h2>
          <Paragraphs text={proposal.summary} />
        </section>
      ) : null}

      {deliverables.length > 0 ? (
        <section>
          <h2 className="h-sub">What we will do</h2>
          <ul className="mt-4 grid gap-2">
            {deliverables.map((item) => (
              <li key={item} className="flex gap-3 text-base">
                <span aria-hidden style={{ color: "var(--blue)" }}>
                  ✓
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="h-sub">The price</h2>
        <div className="card mt-4 overflow-hidden">
          <dl className="grid sm:grid-cols-3">
            {figures.map((figure, index) => (
              <div key={figure.label} className={index > 0 ? "border-t p-5 sm:border-t-0 sm:border-l" : "p-5"} style={{ borderColor: "var(--line)" }}>
                <dt className="text-sm" style={{ color: "var(--mute)" }}>
                  {figure.label}
                </dt>
                <dd className="figure tabular mt-1 text-2xl font-semibold">
                  {figure.pence === 0 && figure.zero ? (
                    <span className="text-base font-medium" style={{ color: "var(--mute)" }}>
                      {figure.zero}
                    </span>
                  ) : (
                    <>
                      {formatPence(figure.pence)}
                      {figure.suffix ? (
                        <span className="text-base font-normal" style={{ color: "var(--mute)" }}>
                          {" "}
                          {figure.suffix}
                        </span>
                      ) : null}
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="border-t px-5 py-4 text-base" style={{ borderColor: "var(--line)" }}>
            {description}
          </p>
        </div>
        {proposal.pricing.vatNote ? (
          <p className="mt-2 text-sm" style={{ color: "var(--mute)" }}>
            {proposal.pricing.vatNote}
          </p>
        ) : null}
      </section>

      {lines.length > 0 ? (
        <section>
          <h2 className="h-sub">What that is made of</h2>
          <div className="mt-4 grid gap-6">
            {LINE_KIND_ORDER.filter((kind) => lines.some((line) => line.kind === kind)).map((kind) => (
              <div key={kind}>
                <p className="h-line">{LINE_KIND_LABEL[kind]}</p>
                <ul className="mt-2">
                  {lines
                    .filter((line) => line.kind === kind)
                    .map((line) => (
                      <li key={line.id} className="flex flex-wrap justify-between gap-3 border-b py-3 text-base" style={{ borderColor: "var(--line)" }}>
                        <span className="min-w-0">
                          {line.description}
                          {line.quantity === 1 ? null : (
                            <span className="block text-sm" style={{ color: "var(--mute)" }}>
                              {line.quantity} × {formatPence(line.unitPence)}
                            </span>
                          )}
                        </span>
                        {/* `ml-auto` as well as `justify-between`: on a phone
                            a long description wraps the amount onto its own
                            line, and a price that suddenly sits left of the
                            one above it reads as a different column. */}
                        <span className="tabular ml-auto shrink-0 font-medium">{formatPence(line.quantity * line.unitPence)}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {timeline ? (
        <section>
          <h2 className="h-sub">Timing</h2>
          <Paragraphs text={timeline} />
        </section>
      ) : null}

      {outOfScope.length > 0 ? (
        <section>
          <h2 className="h-sub">What is not included</h2>
          <ul className="mt-4 grid gap-2">
            {outOfScope.map((item) => (
              <li key={item} className="flex gap-3 text-base" style={{ color: "var(--mute-2)" }}>
                <span aria-hidden>—</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {proposal.terms ? (
        <section>
          <h2 className="h-sub">Terms</h2>
          <Paragraphs text={proposal.terms} />
        </section>
      ) : null}
    </div>
  );
}
