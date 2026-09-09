"use client";

import { Bell } from "lucide-react";
import { type ReactNode, useRef, useState, useTransition } from "react";
import { cn } from "@/lib/utils";

/**
 * The bell's open/closed behaviour, and the one side effect it has.
 *
 * A `<details>` so the panel needs no JavaScript to open, wrapped in a client
 * component for a single reason: the badge has to clear when the client
 * actually *looks*. Stamping "seen" on page load instead would clear it for
 * somebody who only came to pay an invoice, and they would never find out that
 * we had replied to them.
 *
 * The count is dropped optimistically on open rather than after the round
 * trip, because the panel is already showing them the thing the badge was
 * counting.
 */
export function PortalBellShell({
  unseen,
  onOpen,
  children,
}: {
  unseen: number;
  onOpen: () => Promise<void>;
  children: ReactNode;
}) {
  const [count, setCount] = useState(unseen);
  const [, startTransition] = useTransition();
  const stamped = useRef(false);

  return (
    <details
      className="relative [&[open]>summary>svg]:text-primary"
      onToggle={(event) => {
        if (!(event.currentTarget as HTMLDetailsElement).open) return;
        setCount(0);
        // Once per mount: re-opening the panel in the same visit must not
        // fire a write every time.
        if (stamped.current) return;
        stamped.current = true;
        startTransition(() => {
          void onOpen();
        });
      }}
    >
      <summary
        role="button"
        aria-label={count > 0 ? `Updates, ${count} new` : "Updates"}
        className="relative flex size-12 cursor-pointer list-none items-center justify-center rounded-full border text-foreground transition-colors hover:bg-muted"
      >
        <Bell aria-hidden strokeWidth={1.9} className="size-[1.15rem] transition-colors" />
        {count > 0 ? (
          <span
            aria-hidden
            className={cn(
              "absolute top-1 right-1 min-w-4 rounded-full bg-danger-solid px-1 text-center",
              "text-[0.625rem] leading-4 font-semibold tabular-nums text-white",
            )}
          >
            {count > 9 ? "9+" : count}
          </span>
        ) : null}
      </summary>

      {/* Full-width sheet on a phone, a panel under the bell on a desktop —
          the same shape the admin bell settled on. */}
      <div
        className={cn(
          "fixed inset-x-3 top-[4.75rem] z-40 max-h-[70vh] overflow-y-auto rounded-[18px] border bg-popover p-2 shadow-lg",
          "sm:absolute sm:inset-x-auto sm:top-14 sm:right-0 sm:max-h-[30rem] sm:w-[22rem]",
        )}
      >
        {children}
      </div>
    </details>
  );
}
