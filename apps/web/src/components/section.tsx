import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A run of a page: a heading, an optional line of explanation, optional actions
 * and the content.
 *
 * Deliberately not a card. DESIGN.md: sections are separated by space and
 * headings; a card marks a surface — a table, a form, a thread — so wrapping a
 * section in one puts a card inside a card the moment it holds a DataList.
 */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  id,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("mt-8 min-w-0 first:mt-0", className)}>
      {title || actions ? (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0">
            {title ? <h2 className="text-base font-semibold">{title}</h2> : null}
            {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:[&>*]:w-full">{actions}</div>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
