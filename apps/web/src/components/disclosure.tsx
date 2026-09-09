import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A row that opens to reveal its own editing form.
 *
 * A settings list where every row is a full open form is unreadable at eight
 * rows and unusable at twenty: the thing you came to change is somewhere down
 * a page of fields belonging to things you did not. Collapsed, the list is a
 * list again and the page is as long as the number of items.
 *
 * Native `<details>` rather than a scripted accordion, for three reasons: it
 * needs no JavaScript so the page stays a server component, the fields inside
 * still post with the surrounding form when open, and a browser gives us the
 * keyboard behaviour and the screen-reader announcement for nothing.
 *
 * The card border lives here rather than on the form inside it, so a closed row
 * is one surface and not a card wrapping another — DESIGN.md forbids the nest.
 */
export function Disclosure({
  summary,
  meta,
  defaultOpen = false,
  children,
  className,
}: {
  /** The row's title. What you scan the list for. */
  summary: ReactNode;
  /** Optional right-hand detail: a price, a count, a status pill. */
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("group rounded-[20px] border bg-card", className)} open={defaultOpen}>
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-3 rounded-[20px] px-5 py-4 transition-colors sm:px-6",
          "hover:bg-primary-soft/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          // Safari still paints its own triangle without this.
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronRight
          aria-hidden
          strokeWidth={1.75}
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <span className="min-w-0 flex-1">{summary}</span>
        {meta ? <span className="shrink-0 text-meta text-muted-foreground">{meta}</span> : null}
      </summary>
      <div className="border-t px-5 py-5 sm:px-6">{children}</div>
    </details>
  );
}
