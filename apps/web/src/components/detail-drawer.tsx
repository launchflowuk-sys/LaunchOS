"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/**
 * A record's detail, without leaving the list you found it in.
 *
 * The case for it is the scan: you are down a list of forty websites looking
 * for the one on the wrong server, and opening each detail page means a
 * navigation, a read and a back button per candidate. A drawer makes that a
 * glance, and the list keeps its scroll position.
 *
 * It is deliberately **not** a substitute for the detail page. Everything in
 * here is read-only summary; every drawer carries one link to the real page,
 * which is where things are edited. That split is what stops it growing into a
 * second, worse version of the screen it previews.
 *
 * `children` is rendered on the server and passed through — this component is
 * a client boundary only because a sheet needs open/closed state, so the
 * content inside it stays a server component and can hold anything a detail
 * page can.
 */
export function DetailDrawer({
  title,
  description,
  trigger,
  href,
  linkLabel = "Open full page",
  children,
}: {
  title: string;
  description?: string;
  /** The control that opens it. Rendered as-is via `asChild`. */
  trigger: ReactNode;
  /** The record's own page. Every drawer has one; a preview with no way through is a dead end. */
  href: string;
  linkLabel?: string;
  children: ReactNode;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      {/* Full width on a phone — a 75%-wide sheet on 375px leaves a useless
          sliver of list behind it — and a comfortable reading column from
          `sm`. It scrolls itself so a long summary never scrolls the page
          underneath. */}
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">{title}</SheetTitle>
          {description ? <SheetDescription className="break-all">{description}</SheetDescription> : null}
        </SheetHeader>

        <div className="min-w-0 px-4 py-5">{children}</div>

        <SheetFooter className="mt-auto border-t">
          <Button asChild className="w-full">
            <Link href={href}>
              {linkLabel}
              <ArrowUpRight aria-hidden />
            </Link>
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
