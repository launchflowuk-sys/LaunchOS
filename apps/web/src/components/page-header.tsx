import type { ReactNode } from "react";
import { type Category, CATEGORY_DOT } from "@/lib/categories";
import { cn } from "@/lib/utils";

/**
 * Every screen opens the same way: a category dot, the title, one line of
 * description, and the actions.
 *
 * Under `sm` the actions wrap onto their own row and stretch — a phone thumb
 * gets a full-width primary action rather than a 90px button in the corner.
 * There is no eyebrow above the title: the rail already says where you are.
 */
export function PageHeader({
  title,
  description,
  actions,
  category = "overview",
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** The hue of the module this screen belongs to (DESIGN.md category table). */
  category?: Category;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 border-b pb-4", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", CATEGORY_DOT[category])} />
            <h1 className="text-title font-semibold text-balance">{title}</h1>
          </div>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:[&>*]:w-full max-sm:[&>form]:w-full">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Re-exported from its own file so the ~50 screens that already do
 * `import { PageHeader, EmptyState } from "@/components/page-header"` keep
 * working while passes B–E move them over.
 */
export { EmptyState } from "@/components/empty-state";
