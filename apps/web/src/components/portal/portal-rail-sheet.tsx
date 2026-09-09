"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet";
import { PortalHelpCard, PortalNavList } from "./portal-rail";

/**
 * The rail as a drawer, under `lg`.
 *
 * Radix keeps the panel out of the DOM while it is closed, so the desktop rail
 * stays the only navigation landmark on a wide screen.
 */
export function PortalRailSheet() {
  const pathname = usePathname();
  // The drawer remembers the route it opened on, so a tap-through closes it
  // without an effect and never leaves the overlay covering the page it just
  // opened.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;
  const setOpen = (next: boolean) => setOpenedOn(next ? pathname : null);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label="Open menu"
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-[12px] border text-foreground transition-colors hover:bg-muted lg:hidden"
      >
        <Menu aria-hidden strokeWidth={1.75} className="size-5" />
      </SheetTrigger>
      <SheetContent side="left" className="flex w-72 flex-col gap-0 bg-card p-0 sm:max-w-72">
        <SheetHeader className="px-5 py-5">
          {/* Radix needs a title and a description on the dialog; the wordmark
              is the visible one, so the title stays for screen readers only. */}
          <SheetTitle className="sr-only">Portal menu</SheetTitle>
          <BrandMark width={140} />
          <SheetDescription className="label-caps text-muted-foreground">Client portal</SheetDescription>
        </SheetHeader>
        <PortalNavList onNavigate={() => setOpen(false)} />
        <PortalHelpCard onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
