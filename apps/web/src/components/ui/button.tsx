import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2Icon } from "lucide-react";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * The five variants DESIGN.md allows, and nothing else. `primary` is the one
 * indigo action per screen; `success` exists because approving is the single
 * place a green button is the honest colour; `destructive` is the danger red.
 * The old shadcn `default | outline | link` names are gone on purpose — a
 * screen that wants a link should use a link.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent text-sm font-medium whitespace-nowrap transition-colors outline-none select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "border-border bg-card text-foreground hover:bg-muted",
        ghost: "text-foreground hover:bg-muted",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        success: "bg-success-fg text-white hover:bg-success-fg/90",
      },
      size: {
        sm: "h-8 px-3 text-[0.8125rem] [&_svg:not([class*='size-'])]:size-3.5",
        md: "h-9 px-4",
        lg: "h-10 px-5",
        icon: "size-9 px-0",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

function Button({
  className,
  variant = "primary",
  size = "md",
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /**
     * In flight. The label stays put — a button that swaps its words for
     * "Saving…" moves the row under the cursor — and a spinner takes the place
     * of the leading icon. Ignored under `asChild`, where the child owns its
     * own content.
     */
    loading?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      disabled={asChild ? undefined : disabled || loading}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {loading && !asChild ? <Loader2Icon aria-hidden className="animate-spin" /> : null}
      {children}
    </Comp>
  );
}

export { Button, buttonVariants };
