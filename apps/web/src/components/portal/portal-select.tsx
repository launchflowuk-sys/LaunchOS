import { ChevronDown } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
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
 * It wraps the shared `NativeSelect` rather than repeating its classes, so the
 * portal's one dropdown cannot drift from the admin app's controls: all this
 * layer adds is a thumb-sized target, a larger type size and the chevron a
 * `appearance-none` select loses.
 */
export function PortalSelect({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <NativeSelect
        data-slot="select"
        className={cn("h-11 appearance-none py-1 pr-9 pl-3 text-base disabled:pointer-events-none", className)}
        {...props}
      >
        {children}
      </NativeSelect>
      <ChevronDown
        aria-hidden
        strokeWidth={1.75}
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
