import { ArrowRight, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { Category } from "../lib/categories.js";
import { cn } from "../lib/utils.js";

/**
 * A headline figure, as a dark saturated panel on the light canvas.
 *
 * The contrast is the entire idea. These sit above a page of white cards and
 * read as the important thing *because* everything around them is white — make
 * the whole workspace dark and they stop meaning anything at all.
 *
 * Colour does two jobs and they must not be confused. The **category** ground
 * says which part of the product a number belongs to. The **semantic** ground
 * says the number needs a human: `attention` with a non-zero value abandons its
 * category for coral (or amber) and a "Needs you" pill, so "needs you" is never
 * mistaken for "fine" across a row of panels.
 *
 * A zero falls back to navy rather than wearing a bright colour, because a
 * vivid 0 reads as data when it is really the absence of it.
 *
 * Ratios are calculated, not judged by eye: white on navy is 18.93:1, on cobalt
 * 5.41:1, on purple 4.56:1, on teal 6.13:1.
 */
export type AttentionTone = "danger" | "warning";

export type StatTrend = {
  /** "+12%", "-4%". Shown in a pill beside the figure. */
  readonly value: string;
  /** Which way the number moved. Drives the arrow and the pill's tint. */
  readonly direction: "up" | "down";
  /** "vs last month". Optional, and quiet. */
  readonly caption?: string;
};

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
  trend?: StatTrend;
  /**
   * A handful of recent values for the sparkline. Six to twelve reads best;
   * fewer than three draws nothing, because two points is a line, not a trend.
   */
  spark?: readonly number[];
};

/** Written out in full: Tailwind only ships classes it can see as literals. */
const CATEGORY_GROUND: Record<Category, string> = {
  overview: "bg-kpi-navy",
  delivery: "bg-kpi-cobalt",
  support: "bg-kpi-purple",
  money: "bg-kpi-teal",
  automation: "bg-kpi-purple",
  organisation: "bg-kpi-navy",
};

const ATTENTION_GROUND: Record<AttentionTone, string> = {
  danger: "bg-kpi-coral",
  warning: "bg-kpi-amber",
};

/**
 * The sparkline: a polyline in a 100×32 box, stretched to the card.
 *
 * Drawn by hand rather than with a chart library because it is a dozen lines
 * and carries no axes, no labels and no interaction — everything a charting
 * dependency exists to provide. `preserveAspectRatio="none"` lets it fill
 * whatever width the card has, and `vectorEffect` keeps the stroke from
 * stretching with it.
 */
/**
 * The figure's size, chosen by how long the figure is.
 *
 * A KPI card is 176px of usable width at four-up on a 1280px screen, and at
 * 44px the digits run about 0.53em each — so anything past seven characters
 * ran off the card and was silently clipped by its own `overflow-hidden`.
 * "£1,544.40" wanted 207px of a 176px box and lost its last digits, which on a
 * money figure is not a cosmetic bug: £1,544.40 read as £1,544.4.
 *
 * Stepping the size down by length keeps the whole number visible at every
 * width. The thresholds are the 176px worst case divided by 0.53em per
 * character; wider cards simply have room to spare.
 */
function figureSize(value: string | number): string {
  const length = String(value).length;
  // Arbitrary values, not the `text-kpi` token, and not by accident:
  // tailwind-merge cannot tell a custom font-size utility from a text colour,
  // so `text-kpi` was dropped whenever `text-white/60` sat beside it in the
  // same `cn()` — every "all clear" card rendered its 0 at body size. An
  // arbitrary length is recognised as a size and survives.
  if (length <= 7) return "text-[2.75rem]";
  if (length <= 9) return "text-[2.25rem]";
  if (length <= 12) return "text-[1.75rem]";
  return "text-[1.5rem]";
}

function Spark({ points }: { points: readonly number[] }) {
  if (points.length < 3) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  // A flat series would divide by zero; this draws it down the middle instead.
  const span = max - min || 1;
  const path = points
    .map((v, i) => `${(i / (points.length - 1)) * 100},${32 - ((v - min) / span) * 28 - 2}`)
    .join(" ");

  return (
    <svg aria-hidden viewBox="0 0 100 32" preserveAspectRatio="none" className="h-10 w-full opacity-80">
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function StatCard({
  label,
  value,
  hint,
  href,
  category = "overview",
  attention = false,
  attentionTone = "danger",
  icon: Icon,
  trend,
  spark,
}: StatCardProps) {
  const numeric = Number(value);
  // "Needs you" rides under the figure rather than beside the label. In the
  // header it had to share a 176px line with a 36px icon tile and the label,
  // so the label wrapped around it — "Pending / approvals" with a pill in the
  // gap, which reads as broken rather than urgent.
  const isAlarming = attention && numeric > 0;
  const isClear = numeric === 0;

  // A panel that needs you only says "all clear" once it is empty; a portal
  // tile brings its own wording ("Nothing waiting on us") and keeps it.
  const caption = attention && isClear ? "All clear" : hint;

  const ground = isAlarming
    ? ATTENTION_GROUND[attentionTone]
    : isClear
      ? "bg-kpi-navy"
      : CATEGORY_GROUND[category];

  const body = (
    <>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon ? (
            <span
              aria-hidden
              // A tile of the panel's own white at low alpha, so the icon sits
              // in the surface rather than on a second colour fighting it.
              className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/15"
            >
              <Icon className="size-4" strokeWidth={1.9} />
            </span>
          ) : null}
          <p className="text-[0.9375rem] leading-tight font-semibold text-white/85">{label}</p>
        </div>
      </div>

      <div className="mt-4">
        <div className="min-w-0">
          <p
            className={cn(
              figureSize(value),
              "leading-none font-bold tracking-tight tabular-nums",
              isClear && "text-white/60",
            )}
          >
            {value}
          </p>
          {isAlarming ? (
            <span className="label-caps mt-3 inline-flex rounded-full bg-white/20 px-2.5 py-1 whitespace-nowrap">
              Needs you
            </span>
          ) : null}
          {trend ? (
            <span
              className={cn(
                "mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-meta font-semibold whitespace-nowrap",
                // High contrast against the panel, per the brief — a trend that
                // needs squinting at is decoration.
                trend.direction === "up" ? "bg-white/20" : "bg-black/25",
              )}
            >
              {trend.direction === "up" ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
              {trend.value}
              {trend.caption ? <span className="font-normal text-white/70">{trend.caption}</span> : null}
            </span>
          ) : null}
        </div>
      </div>

      {/* Its own full-width row, not a column beside the figure. Beside it,
          the spark was fixed at 144px against a card whose inner width is
          ~228px at four-up — the figure had nowhere to go and drew straight
          through the sparkline. Full width it never competes, and the trend
          is legible instead of being a 144px stub. */}
      {spark && spark.length >= 3 ? (
        <div className="mt-4 min-w-0">
          <Spark points={spark} />
        </div>
      ) : null}

      {caption ? <p className="mt-auto pt-4 text-meta leading-snug text-white/70">{caption}</p> : null}
    </>
  );

  // The 156px floor and 24px padding come from the brief. `mt-auto` on the
  // caption pins the secondary fact to the bottom whether or not a card has a
  // sparkline above it, so a row of them shares one baseline.
  const shell = cn(
    "relative flex min-h-39 flex-col overflow-hidden rounded-[22px] p-6 text-white transition-[transform,box-shadow]",
    ground,
  );

  if (!href) return <div className={shell}>{body}</div>;

  return (
    <Link href={href} className={cn(shell, "group hover:-translate-y-px hover:shadow-[0_12px_32px_rgba(11,16,32,0.18)]")}>
      {body}
      <span
        aria-hidden
        className="absolute right-5 bottom-5 flex size-7 items-center justify-center rounded-full bg-white/15 opacity-0 transition-opacity group-hover:opacity-100"
      >
        <ArrowRight className="size-3.5" />
      </span>
    </Link>
  );
}
