import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A real `<select>`, wearing the shadcn `Input` skin.
 *
 * The shadcn `Select` in this project is the Radix listbox: it renders a
 * button and a floating popover, not a `<select>`, so it cannot be driven by
 * `selectOption` and it does not submit inside the plain GET filter forms and
 * `<form action={serverAction}>` posts this app is built on. Every filter row,
 * status changer and dialog therefore keeps a native control — this component
 * is the one place its styling lives, so no screen hand-rolls border and height
 * classes of its own.
 */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm text-foreground transition-colors outline-none",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
