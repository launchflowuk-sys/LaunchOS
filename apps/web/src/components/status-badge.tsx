import { cn } from "@/lib/utils";

/**
 * The state vocabulary, one pill, used identically in the admin app and the
 * client portal. Solid rather than a pale tint: a state has to be readable at
 * a glance across a list, and a washed-out pill is the thing that makes a
 * screen feel provisional. The word is always present, so the state survives a
 * greyscale print and a colour-blind reader is never relying on hue alone.
 */
const TONES = {
  neutral: "bg-neutral-solid text-white",
  info: "bg-info-solid text-white",
  warn: "bg-warning-solid text-white",
  danger: "bg-danger-solid text-white",
  success: "bg-success-pill text-white",
} as const;

/* The dot used to carry the colour because the pill itself was a pale tint.
   The pill is solid now, so the dot would be a second mark saying the same
   thing; the fill carries the state and the word carries it in greyscale. */

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
  published: "success",
  // site status — `paused` and `archived` are shared with client status above
  live: "success",
  building: "info",
  // domain status — `active` is shared with client status above
  expiring: "warn",
  expired: "danger",
  transferring: "info",
  // message status — `sent` and `failed` are shared with the invoice and agent
  // run families above, and mean the same thing here
  queued: "info",
  received: "neutral",
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
        "inline-flex max-w-full items-center rounded-full px-2.5 py-1 text-[0.8125rem] font-semibold whitespace-nowrap",
        TONES[resolved],
        className,
      )}
    >
      <span className="truncate">{label ?? humanise(value)}</span>
    </span>
  );
}
