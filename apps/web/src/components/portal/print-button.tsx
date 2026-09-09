"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Opens the browser's own print dialog.
 *
 * A page cannot start a download itself, so "save this as a PDF" is the print
 * dialog either way — this only saves a client hunting for it in a phone
 * browser's overflow menu. It is `print:hidden`, like every other bit of
 * chrome around a document.
 */
export function PrintButton({ label = "Print or save as PDF" }: { label?: string }) {
  return (
    <Button type="button" variant="secondary" onClick={() => window.print()} className="print:hidden">
      <Printer aria-hidden strokeWidth={1.75} />
      {label}
    </Button>
  );
}
