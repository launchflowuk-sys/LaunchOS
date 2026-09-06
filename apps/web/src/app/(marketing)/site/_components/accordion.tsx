"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

export type AccordionItem = {
  id: string;
  title: string;
  body: string;
  chips: readonly string[];
};

/**
 * The services rows: one open at a time, the first open on arrival. Buttons
 * with `aria-expanded` and `aria-controls`; each panel is a labelled region
 * that is `inert` while closed, so a screen reader and the tab order see
 * exactly what a sighted visitor sees. Height animates with the grid-rows
 * trick in `marketing.css`, so no script measures anything.
 */
export function Accordion({ items }: { items: readonly AccordionItem[] }) {
  const [open, setOpen] = useState(0);

  return (
    <div>
      {items.map((item, index) => {
        const isOpen = index === open;
        const buttonId = `acc-${item.id}-button`;
        const panelId = `acc-${item.id}-panel`;
        return (
          <div key={item.id} className="acc-row">
            <h3 className="m-0">
              <button
                id={buttonId}
                type="button"
                className="acc-btn"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? -1 : index)}
              >
                <span className="acc-num" aria-hidden>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="acc-title">{item.title}</span>
                <span className="acc-plus" aria-hidden>
                  <Plus className="size-4" strokeWidth={1.75} />
                </span>
              </button>
            </h3>
            <div id={panelId} role="region" aria-labelledby={buttonId} className="acc-panel" data-open={isOpen ? "" : undefined} inert={!isOpen}>
              <div>
                <div className="acc-body">
                  <p>{item.body}</p>
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {item.chips.map((chip) => (
                      <li key={chip} className="chip">
                        {chip}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
