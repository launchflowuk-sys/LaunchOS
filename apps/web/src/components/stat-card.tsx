import Link from "next/link";
import { type Category, CATEGORY_TEXT } from "@/lib/categories";
import { cn } from "@/lib/utils";

/**
 * Dashboard only. A number, what it counts, and where to go and do something
 * about it. The category hue lands on the number — the one place in the product
 * where colour is decoration rather than state, and it stays out of the label
 * so the card still reads at a glance in greyscale.
 *
 * `attention` is the exception: a count that is a problem when it is above
 * zero — pending approvals, overdue tasks — takes the danger ink instead, since
 * DESIGN.md requires "needs you" to be visibly different from calm.
 */
export function StatCard({
  label,
  value,
  hint,
  href,
  category = "overview",
  attention = false,
}: {
  label: string;
  value: number | string;
  hint?: string;
  href?: string;
  category?: Category;
  attention?: boolean;
}) {
  const isAlarming = attention && Number(value) > 0;

  const body = (
    <>
      <p className="label-caps text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-2 text-figure leading-none font-semibold tabular-nums",
          isAlarming ? "text-danger-fg" : CATEGORY_TEXT[category],
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-2 text-meta text-muted-foreground">{hint}</p> : null}
    </>
  );

  const shell = "block rounded-xl border bg-card p-4 transition-colors";

  if (!href) return <div className={shell}>{body}</div>;

  return (
    <Link href={href} className={cn(shell, "hover:border-primary/40 hover:bg-primary-soft/40")}>
      {body}
    </Link>
  );
}
