"use client";

import type { PortalSearchResults } from "@launchos/core";
import { FileText, FolderClosed, Globe, Link2, ListChecks, Receipt, Search, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

/**
 * "Search your portal".
 *
 * A client opens this a few times a year and does not know our nouns, so the
 * results are grouped under their words — Websites, Domains, Requests, Work,
 * Invoices, Documents — and every row is a link to the screen that already
 * exists. Nothing is rendered here that a client could not reach by clicking.
 *
 * The filtering itself is entirely server side (`/api/portal/search`), and the
 * client id comes from the session there rather than from anything this
 * component sends. That is deliberate: the tenancy boundary must not be a
 * value the browser can choose.
 */

/** Every row of every kind carries an id and the one string a person reads. */
type Hit = { id: string } & Record<string, unknown>;

interface Group {
  key: keyof PortalSearchResults;
  label: string;
  icon: LucideIcon;
  /** The property holding the label — `name` on a site, `number` on an invoice. */
  field: string;
  href: (id: string) => string;
}

/** One place that says what each kind is called, where a row goes, and what to read off it. */
const GROUPS: readonly Group[] = [
  { key: "sites", label: "Websites", icon: Globe, field: "name", href: () => "/portal/sites" },
  { key: "domains", label: "Domains", icon: Link2, field: "name", href: () => "/portal/domains" },
  { key: "requests", label: "Requests", icon: FileText, field: "subject", href: (id) => `/portal/support/${id}` },
  { key: "tasks", label: "Work under way", icon: ListChecks, field: "title", href: () => "/portal/tasks" },
  { key: "invoices", label: "Invoices", icon: Receipt, field: "number", href: (id) => `/portal/invoices/${id}` },
  { key: "documents", label: "Documents", icon: FolderClosed, field: "title", href: () => "/portal/documents" },
];

/** Reads the label off a row without widening anything to `any`. */
function labelOf(row: Hit, field: string): string {
  const value = row[field];
  return typeof value === "string" ? value : "";
}

const EMPTY: PortalSearchResults = { sites: [], domains: [], requests: [], tasks: [], invoices: [], documents: [] };

export function PortalSearch() {
  const router = useRouter();
  const listId = useId();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PortalSearchResults>(EMPTY);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Debounced, and every in-flight request is abandoned when the next keystroke
  // arrives — without the abort, a slow early query can land after a fast later
  // one and put stale rows under a newer term.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(EMPTY);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/portal/search?q=${encodeURIComponent(term)}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : EMPTY))
        .then((data: PortalSearchResults) => setResults(data))
        .catch(() => {
          /* aborted or offline: leave the last good rows alone */
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  // Clicking anywhere else closes it. Pointerdown rather than click so the
  // panel is gone before a click on the page behind it does anything.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const groups = GROUPS.map((group) => ({ group, rows: results[group.key] as Hit[] })).filter(({ rows }) => rows.length > 0);
  const total = groups.reduce((sum, { rows }) => sum + rows.length, 0);
  const searched = q.trim().length >= 2;

  return (
    <div ref={box} className="relative min-w-0 flex-1">
      <label htmlFor={listId} className="sr-only">
        Search your portal
      </label>
      <div className="relative">
        <Search
          aria-hidden
          strokeWidth={1.75}
          className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          id={listId}
          type="search"
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
          placeholder="Search your portal"
          autoComplete="off"
          className="h-12 w-full rounded-full border bg-transparent pr-4 pl-11 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-primary"
        />
      </div>

      {open && searched ? (
        <div className="absolute top-14 right-0 left-0 z-40 max-h-[70vh] overflow-y-auto rounded-[20px] border bg-popover p-2 shadow-lg">
          {total === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing matching &ldquo;{q.trim()}&rdquo;. Try a website name, a request or an invoice number.
            </p>
          ) : (
            groups.map(({ group, rows }) => {
              const Icon = group.icon;
              return (
                <div key={group.key} className="pb-1">
                  <p className="label-caps px-3 pt-2 pb-1 text-muted-foreground">{group.label}</p>
                  {rows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        setQ("");
                        router.push(group.href(row.id));
                      }}
                      className="flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors hover:bg-muted"
                    >
                      <Icon aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{labelOf(row, group.field)}</span>
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
