import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The filter/search row above a list: a wrapping row of controls with their
 * labels above them. Under `sm` every control is full width, because a row of
 * half-width selects on a 375px screen is unusable and a wrapped one is not.
 *
 * It is a plain container, so it works wrapped in a `<form>` (the GET filter
 * forms most list screens use) or on its own.
 */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-4 flex flex-wrap items-end gap-3", className)}>{children}</div>;
}

/** `FilterBar` is the same row; the name says what it holds. */
export const FilterBar = Toolbar;

/**
 * One labelled control. Pass the control's own `id` as `htmlFor` so the label
 * is a real label — the toolbar never relies on placeholder text as a name.
 */
export function ToolbarField({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-1.5 sm:w-auto", className)}>
      <label htmlFor={htmlFor} className="label-caps text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * The buttons at the end of the row. They sit right on a wide screen and go
 * full width under `sm`, matching the field above them.
 */
export function ToolbarActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto max-sm:[&>*]:w-full",
        className,
      )}
    >
      {children}
    </div>
  );
}
