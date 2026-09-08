import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A field is a border and nothing else — no fill, no shadow, no plate floating
 * on the page. On focus the border and ring take `--ring`, which on this dark
 * workspace is the brand cyan (8.00:1 against a card), so the focused field is
 * unmistakable without the control ever having had a background of its own.
 *
 * The `dark:` variants shadcn ships were removed rather than translated: the
 * workspace *is* dark, so there is no `.dark` class for them to match and they
 * were dead weight pretending to be behaviour.
 */

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
