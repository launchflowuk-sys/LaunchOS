import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A native `<select>` wearing the shadcn `Input` shape.
 *
 * The portal deliberately does **not** use the Radix `Select` the admin app
 * reaches for. A client picks a severity once, on a phone, and a native control
 * opens the operating system's own wheel picker — bigger targets, familiar
 * gestures, and it works before React has hydrated. The Radix listbox is a
 * div-and-portal reimplementation of all of that.
 *
 * It is a component rather than a class string copied onto a bare `<select>`
 * so the portal's one dropdown cannot drift from the portal's text inputs.
 */
export function PortalSelect({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        data-slot="select"
        className={cn(
          "h-11 w-full min-w-0 appearance-none rounded-lg border border-input bg-card py-1 pr-9 pl-3 text-base transition-colors outline-none",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        strokeWidth={1.75}
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
