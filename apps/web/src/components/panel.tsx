import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { type Category, CATEGORY_TEXT } from "@/lib/categories";
import { cn } from "@/lib/utils";

/**
 * A white content surface with a titled header.
 *
 * The counterpart to `StatCard`: those are the dark saturated figures, these
 * are everything underneath. Operational content stays light because it is
 * *read* — tables, lists, rows of names and dates — and reading is what a dark
 * surface is worst at.
 *
 * A tinted icon tile carries the category hue, which is the only colour in the
 * header. `Section` remains the right choice for a heading over open content;
 * this is for content that needs a box around it.
 */
const TILE: Record<Category, string> = {
  overview: "bg-primary/10 text-primary",
  delivery: "bg-category-delivery/12 text-category-delivery",
  support: "bg-category-support/12 text-category-support",
  money: "bg-category-money/12 text-category-money",
  automation: "bg-category-automation/12 text-category-automation",
  organisation: "bg-category-organisation/12 text-category-organisation",
};

export function Panel({
  title,
  description,
  icon: Icon,
  category = "overview",
  action,
  figure,
  children,
  className,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  category?: Category;
  /** The one optional link in the header — "View all projects". */
  action?: { label: string; href: string };
  /** A headline number shown under the title, for panels that lead with one. */
  figure?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        // No shadow and no second ground: a hairline on a white page, which is
        // the whole difference between a panel and a box floating on grey.
        "rounded-[20px] border bg-card p-6 sm:p-7",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {Icon ? (
            <span aria-hidden className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", TILE[category])}>
              <Icon className="size-5" strokeWidth={1.9} />
            </span>
          ) : null}
          <div className="min-w-0">
            <h2 className="text-xl leading-tight font-semibold tracking-tight">{title}</h2>
            {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
          </div>
        </div>
        {action ? (
          <Link
            href={action.href}
            className="shrink-0 rounded-lg border px-3 py-1.5 text-meta font-semibold whitespace-nowrap transition-colors hover:bg-muted"
          >
            {action.label}
          </Link>
        ) : null}
      </div>

      {figure ? (
        <p className={cn("mt-4 text-figure leading-none font-bold tracking-tight tabular-nums", CATEGORY_TEXT[category])}>
          {figure}
        </p>
      ) : null}

      <div className={figure ? "mt-4" : "mt-5"}>{children}</div>
    </section>
  );
}
