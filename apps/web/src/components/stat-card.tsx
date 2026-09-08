import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { Category } from "@/lib/categories";
import { cn } from "@/lib/utils";

/**
 * A headline figure, as a filled panel.
 *
 * The old version was a white card with a 3px coloured edge and a coloured
 * number — right for a light workspace, invisible in a dark one, where a card
 * differs from the page by a shade and a hairline. So the colour moved from a
 * detail to the whole surface: the panel *is* the category hue, and the figure
 * sits on it in white. That is what makes a row of these read as a dashboard
 * from across the room rather than a list of boxes.
 *
 * Colour still does the two jobs it always did, and they still must not be
 * confused. The **category** hue says which part of the product a number
 * belongs to. The **semantic** vocabulary says the number needs a human: a
 * panel with `attention` and a non-zero value abandons its category entirely,
 * takes the danger (or warning) ground and a "Needs you" pill, so DESIGN.md's
 * "needs you is never mistaken for fine" survives a squint across six panels.
 *
 * A zero is the third state and keeps the reasoning it had before: the panel
 * falls back to slate rather than wearing a colour, because a bright 0 reads as
 * data when it is really the absence of it.
 *
 * Every ground carries white at 6.97:1 or better — the ratios are in
 * `globals.css` beside each token, calculated rather than judged by eye.
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

/** Written out in full: Tailwind only ships classes it can see as literals. */
const CATEGORY_GROUND: Record<Category, string> = {
  overview: "bg-kpi-slate",
  delivery: "bg-kpi-blue",
  support: "bg-kpi-indigo",
  money: "bg-kpi-teal",
  automation: "bg-kpi-violet",
  organisation: "bg-kpi-slate",
};

const ATTENTION_GROUND: Record<AttentionTone, string> = {
  danger: "bg-kpi-danger",
  warning: "bg-kpi-warning",
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

  // A panel that needs you only says "all clear" once it is empty; a portal
  // tile brings its own wording ("Nothing waiting on us") and keeps it.
  const caption = attention && isClear ? "All clear" : hint;

  const ground = isAlarming
    ? ATTENTION_GROUND[attentionTone]
    : isClear
      ? "bg-kpi-slate"
      : CATEGORY_GROUND[category];

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        {Icon ? (
          <span
            aria-hidden
            // A disc of the panel's own white at low alpha, so the icon sits in
            // the surface rather than on a second colour fighting the first.
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/15 text-white"
          >
            <Icon className="size-4" strokeWidth={1.75} />
          </span>
        ) : null}
        {isAlarming ? (
          <span className="label-caps ml-auto rounded-full bg-white/20 px-2 py-0.5 whitespace-nowrap text-white">
            Needs you
          </span>
        ) : null}
      </div>
      {/* An icon means this is one of a row of panels, where two-up on a phone
          and six-up on a desktop some labels wrap and some do not, and figures
          sitting at different heights read as an accident. Two lines' worth of
          room whether or not the label needs it fixes the baseline; the
          portal's three wider tiles keep their tighter spacing. */}
      <p className={cn("label-caps text-white/70", Icon ? "mt-3 min-h-8" : undefined)}>{label}</p>
      <p
        className={cn(
          "mt-1 text-figure leading-none font-semibold tabular-nums",
          // A zero stays deliberately quiet even on the slate ground.
          isClear ? "text-white/55" : "text-white",
        )}
      >
        {value}
      </p>
      {caption ? <p className="mt-2 text-meta leading-snug text-white/70">{caption}</p> : null}
    </>
  );

  const shell = cn(
    "relative block overflow-hidden rounded-xl p-3 transition-[filter,transform] sm:p-4",
    ground,
  );

  if (!href) return <div className={shell}>{body}</div>;

  return (
    // No border to brighten and no colour to swap: the panel is already the
    // colour, so hover lifts it slightly instead of repainting it.
    <Link href={href} className={cn(shell, "hover:brightness-115")}>
      {body}
    </Link>
  );
}
