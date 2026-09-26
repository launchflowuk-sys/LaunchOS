"use client";

import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

/**
 * One server row. The expand toggle is its own button rather than a
 * `<summary>` wrapping the whole row, so the business select and the actions
 * menu sit beside it instead of inside it — no click on them can also toggle
 * the row, and no interactive control is nested in another.
 */
export function ExpandableRow({ name, cells, children }: { name: string; cells: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div data-server-row={name} className={`border-b px-4 last:border-0 ${open ? "bg-muted/30" : ""}`}>
      <div className="flex items-center gap-2.5 py-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${open ? "Hide" : "Show"} details for ${name}`}
          onClick={() => setOpen((was) => !was)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronRight className={`size-4 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        {cells}
      </div>
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
