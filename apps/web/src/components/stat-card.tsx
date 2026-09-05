import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { type Category, CATEGORY_TEXT } from "@/lib/categories";
import { cn } from "@/lib/utils";

/**
 * Dashboard and portal headline figures. A number, what it counts, and where to
 * go and do something about it.
 *
 * Colour does two jobs here and they must not be confused. The **category** hue
 * says which part of the product the number belongs to: it lands on a 3px top
 * edge, a tinted icon disc and the figure itself. The **semantic** vocabulary
 * says the number needs a human: a tile with `attention` and a non-zero value
 * drops the category hue entirely and takes the danger (or warning) tint,
 * border, figure and a "Needs you" pill, so DESIGN.md's "needs you is never
 * mistaken for fine" survives a squint across six tiles.
 *
 * A zero is the third state: the figure goes muted rather than coloured, since
 * a bright 0 reads as data when it is really the absence of it.
 */
export type AttentionTone = "danger" | "warning";

export type StatCardProps = {
  label: string;
  value: number | string;
  hint?: string;
  href?: string;
  category?: Category;
  /** True when a count above zero is a problem — approvals, incidents, overdue. */
  attention?: boolean;
  /** Which semantic tone the alarm takes. Defaults to danger. */
  attentionTone?: AttentionTone;
  icon?: LucideIcon;
};

/** The 3px top edge. Written out in full: Tailwind only ships literal classes. */
const CATEGORY_EDGE: Record<Category, string> = {
  overview: "bg-primary",
  delivery: "bg-category-delivery",
  support: "bg-category-support",
  money: "bg-category-money",
  automation: "bg-category-automation",
  organisation: "bg-category-organisation",
};

/** The icon disc: the same hue at 15% behind the icon at full strength. */
const CATEGORY_DISC: Record<Category, string> = {
  overview: "bg-primary/15 text-primary",
  delivery: "bg-category-delivery/15 text-category-delivery",
  support: "bg-category-support/15 text-category-support",
  money: "bg-category-money/15 text-category-money",
  automation: "bg-category-automation/15 text-category-automation",
  organisation: "bg-category-organisation/15 text-category-organisation",
};

const ATTENTION: Record<AttentionTone, {
  edge: string;
  shell: string;
  hover: string;
  disc: string;
  figure: string;
  pill: string;
}> = {
  danger: {
    edge: "bg-danger-fg",
    shell: "border-danger-border bg-danger-bg",
    hover: "hover:border-danger-fg/40",
    disc: "bg-danger-fg/15 text-danger-fg",
    figure: "text-danger-fg",
    pill: "border-danger-border text-danger-fg",
  },
  warning: {
    edge: "bg-warning-fg",
    shell: "border-warning-border bg-warning-bg",
    hover: "hover:border-warning-fg/40",
    disc: "bg-warning-fg/15 text-warning-fg",
    figure: "text-warning-fg",
    pill: "border-warning-border text-warning-fg",
  },
};

export function StatCard({
  label,
  value,
  hint,
  href,
  category = "overview",
  attention = false,
  attentionTone = "danger",
  icon: Icon,
}: StatCardProps) {
  const numeric = Number(value);
  const isAlarming = attention && numeric > 0;
  const isClear = numeric === 0;
  const tone = ATTENTION[attentionTone];

  // A tile that needs you only says "all clear" once it is empty; a portal tile
  // brings its own wording ("Nothing waiting on us") and keeps it.
  const caption = attention && isClear ? "All clear" : hint;

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        {Icon ? (
          <span
            aria-hidden
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              isAlarming ? tone.disc : CATEGORY_DISC[category],
            )}
          >
            <Icon className="size-4" strokeWidth={1.75} />
          </span>
        ) : null}
        {isAlarming ? (
          <span
            className={cn(
              "label-caps ml-auto rounded-full border bg-card px-2 py-0.5 whitespace-nowrap",
              tone.pill,
            )}
          >
            Needs you
          </span>
        ) : null}
      </div>
      {/* An icon means this is a tile in a row of tiles (the dashboard), where
          two-up on a phone and six-up on a desktop some labels wrap and some do
          not, and figures sitting at different heights read as an accident. Two
          lines' worth of room whether or not the label needs it fixes the
          baseline; the portal's three wider tiles keep their tighter spacing. */}
      <p className={cn("label-caps text-muted-foreground", Icon ? "mt-3 min-h-8" : undefined)}>{label}</p>
      <p
        className={cn(
          "mt-1 text-figure leading-none font-semibold tabular-nums",
          isAlarming ? tone.figure : isClear ? "text-muted-foreground" : CATEGORY_TEXT[category],
        )}
      >
        {value}
      </p>
      {caption ? <p className="mt-2 text-meta leading-snug text-muted-foreground">{caption}</p> : null}
    </>
  );

  // The category (or alarm) hue as a 3px top edge, inside the rounded corner
  // rather than as a border, so the corner radius stays a single arc.
  const edge = (
    <span
      aria-hidden
      className={cn("absolute inset-x-0 top-0 h-[3px]", isAlarming ? tone.edge : CATEGORY_EDGE[category])}
    />
  );

  const shell = cn(
    "relative block overflow-hidden rounded-xl border p-3 transition-colors sm:p-4",
    isAlarming ? tone.shell : "bg-card",
  );

  if (!href) {
    return (
      <div className={shell}>
        {edge}
        {body}
      </div>
    );
  }

  return (
    <Link
      href={href}
      className={cn(shell, isAlarming ? tone.hover : "hover:border-primary/40 hover:bg-primary-soft/40")}
    >
      {edge}
      {body}
    </Link>
  );
}
