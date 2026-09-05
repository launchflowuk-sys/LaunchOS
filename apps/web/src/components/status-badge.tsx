import { cn } from "@/lib/utils";

/**
 * The state vocabulary, one pill, used identically in the admin app and the
 * client portal. A leading dot carries the colour so the state survives a
 * greyscale print and a colour-blind reader still has the word.
 */
const TONES = {
  neutral: "border-neutral-border bg-neutral-bg text-neutral-fg",
  info: "border-info-border bg-info-bg text-info-fg",
  warn: "border-warning-border bg-warning-bg text-warning-fg",
  danger: "border-danger-border bg-danger-bg text-danger-fg",
  success: "border-success-border bg-success-bg text-success-fg",
} as const;

const DOTS = {
  neutral: "bg-neutral-fg",
  info: "bg-info-fg",
  warn: "bg-warning-fg",
  danger: "bg-danger-fg",
  success: "bg-success-fg",
} as const;

export type StatusTone = keyof typeof TONES;

/**
 * The map every screen shares. It is deliberately exhaustive rather than
 * clever: a value that lands here with no entry reads `neutral`, which is the
 * safe direction — a calm pill for an unknown state, never a false alarm.
 */
const TONE_BY_VALUE: Record<string, StatusTone> = {
  // incident + ticket status
  open: "danger",
  acknowledged: "warn",
  resolved: "success",
  closed: "neutral",
  triaged: "info",
  in_progress: "info",
  waiting_client: "warn",
  // severity
  low: "neutral",
  medium: "info",
  high: "warn",
  critical: "danger",
  // agent run status
  running: "info",
  completed: "success",
  awaiting_approval: "warn",
  failed: "danger",
  // approvals
  pending: "warn",
  approved: "success",
  rejected: "danger",
  // task status
  todo: "neutral",
  blocked: "danger",
  review: "info",
  done: "success",
  cancelled: "neutral",
  // task priority
  urgent: "danger",
  // task phase
  onboarding: "info",
  recurring: "neutral",
  support: "warn",
  // client status
  active: "success",
  paused: "warn",
  archived: "neutral",
  // portal + team account status
  suspended: "danger",
  invited: "info",
  // invoices
  draft: "neutral",
  sent: "info",
  paid: "success",
  overdue: "danger",
  void: "neutral",
  // subscriptions
  trialing: "info",
  past_due: "danger",
  // payments
  succeeded: "success",
  refunded: "warn",
  // ad accounts and reports
  disconnected: "danger",
};

/**
 * `waiting_client` is a database value; "waiting client" is English. The case is
 * left alone on purpose — these are status words in running rows, not titles,
 * and the acceptance specs read them as they are stored.
 */
function humanise(value: string): string {
  return value.replaceAll("_", " ");
}

export function StatusBadge({
  value,
  tone,
  label,
  className,
}: {
  value: string;
  tone?: StatusTone;
  /** Override the words without changing which colour the value maps to. */
  label?: string;
  className?: string;
}) {
  const resolved = tone ?? TONE_BY_VALUE[value] ?? "neutral";
  return (
    <span
      data-status={value}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-meta font-medium whitespace-nowrap",
        TONES[resolved],
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOTS[resolved])} />
      <span className="truncate">{label ?? humanise(value)}</span>
    </span>
  );
}
