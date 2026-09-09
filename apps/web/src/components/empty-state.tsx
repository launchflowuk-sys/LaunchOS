import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one empty state. A 20px lucide icon, one sentence that says what would be
 * here and how it gets here, and — where the reader can do something about it —
 * one action.
 *
 * `children` is the sentence. It stays supported alongside `title` because most
 * of the product already writes `<EmptyState>No invoices yet…</EmptyState>`, and
 * a sentence is the right amount of copy for nearly every case.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  children,
  action,
  className,
}: {
  icon?: LucideIcon;
  /** A short heading above the sentence. Most call sites do not need one. */
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-10 text-center",
        className,
      )}
    >
      <Icon aria-hidden strokeWidth={1.75} className="size-5 text-muted-foreground" />
      {title ? <p className="mt-3 text-base font-semibold">{title}</p> : null}
      {children ? (
        <p className={cn("max-w-prose text-sm text-muted-foreground", title ? "mt-1" : "mt-3")}>{children}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
