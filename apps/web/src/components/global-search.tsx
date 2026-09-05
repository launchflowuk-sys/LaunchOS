"use client";

import type { SearchResults } from "@launchos/core";
import { Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const EMPTY: SearchResults = { clients: [], sites: [], domains: [], tickets: [], tasks: [] };
const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;
const BLUR_DISMISS_MS = 150;

type Hits = { query: string; results: SearchResults };

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  // The hits carry the term they answered, so the panel can be derived during
  // render rather than cleared from an effect (which cascades renders).
  const [hits, setHits] = useState<Hits>({ query: "", results: EMPTY });
  const [dismissed, setDismissed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const term = query.trim();
  const results = !dismissed && term.length >= MIN_QUERY_LENGTH && hits.query === term ? hits.results : EMPTY;

  useEffect(() => {
    if (term.length < MIN_QUERY_LENGTH) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: controller.signal });
        setHits({ query: term, results: response.ok ? ((await response.json()) as SearchResults) : EMPTY });
      } catch {
        // Aborted by the next keystroke, or the request failed: keep the last
        // rendered results rather than flashing an error into the header.
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term]);

  const groups = [
    { label: "Clients", rows: results.clients.map((c) => ({ id: c.id, label: c.name, hint: c.slug, href: `/clients/${c.id}` })) },
    { label: "Websites", rows: results.sites.map((s) => ({ id: s.id, label: s.name, hint: s.primaryUrl, href: `/websites/${s.id}` })) },
    { label: "Domains", rows: results.domains.map((d) => ({ id: d.id, label: d.name, hint: "", href: `/domains/${d.id}` })) },
    // Straight to the case: search finds closed ones too, and the default
    // /cases view hides those.
    { label: "Open cases", rows: results.tickets.map((t) => ({ id: t.id, label: t.subject, hint: t.status, href: `/cases/${t.id}` })) },
    { label: "Tasks", rows: results.tasks.map((t) => ({ id: t.id, label: t.title, hint: t.status, href: `/tasks/${t.id}` })) },
  ].filter((g) => g.rows.length > 0);

  return (
    <div ref={containerRef} className="relative w-full min-w-0 max-w-md">
      <Search
        aria-hidden
        strokeWidth={1.75}
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        aria-label="Search"
        placeholder="Search clients, websites, domains, cases, tasks"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setDismissed(false);
        }}
        // Let a click on a result land before the panel goes away.
        onBlur={() => setTimeout(() => setDismissed(true), BLUR_DISMISS_MS)}
        className="h-9 w-full rounded-md border bg-card pr-3 pl-9 text-sm text-foreground transition-colors placeholder:text-muted-foreground hover:border-primary/30"
      />
      {groups.length > 0 ? (
        <div className="absolute top-11 right-0 left-0 z-40 max-h-96 overflow-y-auto rounded-lg border bg-popover p-2 shadow-lg">
          {groups.map((group) => (
            <div key={group.label} className="mb-2 last:mb-0">
              <p className="label-caps px-2 pb-1 text-muted-foreground">{group.label}</p>
              {group.rows.map((row) => (
                <Link
                  key={row.id}
                  href={row.href}
                  onClick={() => {
                    setQuery("");
                    setDismissed(true);
                  }}
                  className="block rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                >
                  {row.label}
                  {row.hint ? <span className="ml-2 text-meta text-muted-foreground">{row.hint}</span> : null}
                </Link>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
