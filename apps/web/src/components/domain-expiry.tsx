import { EXPIRY_THRESHOLD_DAYS } from "@launchos/core";
import { cn } from "@/lib/utils";

/**
 * How long a domain has left, said in the fewest words that still carry
 * urgency.
 *
 * A raw date is what this column used to print, and a raw date is a thing you
 * have to do arithmetic on before it means anything — which is why nobody ever
 * noticed one getting close. "in 9 days", in amber, needs no arithmetic.
 */

const SOON = EXPIRY_THRESHOLD_DAYS[0];

function words(days: number): string {
  if (days < 0) return `expired ${Math.abs(days)}d ago`;
  if (days === 0) return "expires today";
  if (days === 1) return "1 day left";
  if (days <= 90) return `${days} days left`;
  const months = Math.round(days / 30);
  return `${months} months left`;
}

/** Red once gone, amber inside the warning window, quiet beyond it. */
function toneFor(days: number): string {
  if (days < 0) return "bg-danger-bg text-danger-fg";
  if (days <= 14) return "bg-danger-bg text-danger-fg";
  if (days <= SOON) return "bg-warning-bg text-warning-fg";
  return "bg-muted text-muted-foreground";
}

export function DomainExpiry({
  expiresAt,
  now = new Date(),
  className,
}: {
  expiresAt: Date | null;
  now?: Date;
  className?: string;
}) {
  if (!expiresAt) {
    // Not "—". An unknown renewal date is a gap in the records, and saying so
    // is the only way it ever gets filled in.
    return <span className={cn("text-meta text-muted-foreground", className)}>Not recorded</span>;
  }

  const days = Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000);
  const date = expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  return (
    <span className={cn("flex flex-wrap items-center gap-2", className)}>
      <span className={cn("rounded-full px-2.5 py-1 text-label font-semibold whitespace-nowrap", toneFor(days))}>
        {words(days)}
      </span>
      <span className="text-meta whitespace-nowrap text-muted-foreground">{date}</span>
    </span>
  );
}
