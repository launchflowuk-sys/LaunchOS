import type { ProposalRow } from "@launchos/core";
import { Check, CircleDashed, CircleSlash } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Where a proposal has got to: drafted → sent → opened → decided.
 *
 * Four steps and not six, because `accepted`, `declined` and `expired` are
 * three answers to the same question and belong in one place rather than three
 * boxes that can never all light up. The last step therefore changes its words
 * and its colour with the outcome, and an outcome nobody gave — the client
 * never opened it, the date ran out — reads as the outcome it is.
 *
 * Timestamps are the point of the thing, so every step that has one shows it.
 */
type Step = {
  label: string;
  at: Date | null;
  /** Reached: a filled tick. Pending: an outline. Refused: a struck circle. */
  state: "done" | "pending" | "refused";
  hint?: string;
};

function steps(proposal: ProposalRow): Step[] {
  const decided = proposal.status === "accepted" || proposal.status === "declined" || proposal.status === "expired";
  const outcome: Step = {
    label:
      proposal.status === "accepted"
        ? "Accepted"
        : proposal.status === "declined"
          ? "Declined"
          : proposal.status === "expired"
            ? "Expired"
            : "Decision",
    at: proposal.decidedAt,
    state: proposal.status === "accepted" ? "done" : decided ? "refused" : "pending",
    ...(proposal.status === "expired" && proposal.validUntil ? { hint: `It was valid until ${proposal.validUntil}` } : {}),
  };

  return [
    { label: "Drafted", at: proposal.createdAt, state: "done" },
    { label: "Sent", at: proposal.sentAt, state: proposal.sentAt ? "done" : "pending" },
    { label: "Opened by the client", at: proposal.firstViewedAt, state: proposal.firstViewedAt ? "done" : "pending" },
    outcome,
  ];
}

const MARK = {
  done: { icon: Check, ring: "border-success-border bg-success-bg text-success-fg", rule: "bg-success-border" },
  refused: { icon: CircleSlash, ring: "border-danger-border bg-danger-bg text-danger-fg", rule: "bg-border" },
  pending: { icon: CircleDashed, ring: "border-border bg-card text-muted-foreground", rule: "bg-border" },
} as const;

export function StatusTrail({ proposal }: { proposal: ProposalRow }) {
  const trail = steps(proposal);

  return (
    <ol className="grid gap-0 sm:grid-flow-col sm:auto-cols-fr">
      {trail.map((step, index) => {
        const { icon: Icon, ring, rule } = MARK[step.state];
        const last = index === trail.length - 1;
        return (
          <li key={step.label} className="flex min-w-0 gap-3 sm:block">
            {/* On a phone the trail runs down the left as a rule between the
                marks; from `sm` it turns and the rule runs along the top. */}
            <div className="flex flex-col items-center sm:flex-row sm:items-center">
              <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border", ring)}>
                <Icon aria-hidden strokeWidth={1.75} className="size-3.5" />
              </span>
              {last ? null : <span aria-hidden className={cn("w-px flex-1 sm:h-px sm:w-full sm:flex-1", rule)} />}
            </div>
            <div className={cn("min-w-0 pb-5 sm:pt-2 sm:pb-0", last && "pb-0")}>
              <p className="text-sm font-medium">{step.label}</p>
              <p className="text-meta text-muted-foreground">{step.at ? formatDateTime(step.at) : "—"}</p>
              {step.hint ? <p className="text-meta text-muted-foreground">{step.hint}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
