"use client";

import type { SearchResults } from "@launchos/core";
import { Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const EMPTY: SearchResults = { clients: [], sites: [], domains: [], tickets: [], tasks: [] };
const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

type Hits = { query: string; results: SearchResults };
type Row = { id: string; label: string; hint: string; href: string };

/**
 * The front door to the whole platform.
 *
 * Deliberately the widest, tallest control in the shell: it is how you reach a
 * client, a site, a domain, a case or a task without first working out which
 * screen holds them. The brand tint and the 48px height are the point — a
 * 36px grey box reads as a filter for the page you are on, which is exactly
 * what this is not.
 *
 * Keyboard throughout: ⌘K / Ctrl+K focuses it from anywhere, arrows walk the
 * results, Enter opens, Escape closes. The panel suppresses `mousedown` so a
 * click on a result never races the input's own blur — the timeout that used
 * to stand in for this lost the click whenever the machine was busy.
 */
export function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  // The hits carry the term they answered, so the panel can be derived during
  // render rather than cleared from an effect (which cascades renders).
  const [hits, setHits] = useState<Hits>({ query: "", results: EMPTY });
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const term = query.trim();
  const results = !dismissed && term.length >= MIN_QUERY_LENGTH && hits.query === term ? hits.results : EMPTY;

  useEffect(() => {
    if (term.length < MIN_QUERY_LENGTH) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: controller.signal });
        setHits({ query: term, results: response.ok ? ((await response.json()) as SearchResults) : EMPTY });
        setActive(0);
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

  // ⌘K / Ctrl+K from anywhere. Bound on the document because the point of a
  // platform search is that you do not have to be near it to use it.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const groups = useMemo(
    () =>
      [
        { label: "Clients", rows: results.clients.map((c) => ({ id: c.id, label: c.name, hint: c.slug, href: `/clients/${c.id}` })) },
        { label: "Websites", rows: results.sites.map((s) => ({ id: s.id, label: s.name, hint: s.primaryUrl, href: `/websites/${s.id}` })) },
        { label: "Domains", rows: results.domains.map((d) => ({ id: d.id, label: d.name, hint: "", href: `/domains/${d.id}` })) },
        // Straight to the case: search finds closed ones too, and the default
        // /cases view hides those.
        { label: "Open cases", rows: results.tickets.map((t) => ({ id: t.id, label: t.subject, hint: t.status, href: `/cases/${t.id}` })) },
        { label: "Tasks", rows: results.tasks.map((t) => ({ id: t.id, label: t.title, hint: t.status, href: `/tasks/${t.id}` })) },
      ].filter((g) => g.rows.length > 0),
    [results],
  );

  // One flat list behind the grouped display, so the arrow keys can cross a
  // group boundary without the user having to know there was one.
  const flat: Row[] = groups.flatMap((group) => group.rows);
  const open = flat.length > 0;

  function close() {
    setQuery("");
    setDismissed(true);
    setActive(0);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setDismissed(true);
      inputRef.current?.blur();
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index + 1) % flat.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index - 1 + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      const row = flat[active];
      if (!row) return;
      event.preventDefault();
      close();
      router.push(row.href);
    }
  }

  return (
    <div className="relative w-full min-w-0 max-w-2xl">
      <Search
        aria-hidden
        strokeWidth={2}
        className="pointer-events-none absolute top-1/2 left-4 size-[1.15rem] -translate-y-1/2 text-primary"
      />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls="global-search-results"
        aria-label="Search the whole platform"
        placeholder="Search clients, sites, domains, cases, tasks"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setDismissed(false);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setDismissed(false)}
        className={cn(
          // Fat, bordered, and tinted with the brand rather than sitting in a
          // grey well: 48px to match every other real field in the product,
          // and the same 14px corner.
          "h-12 w-full rounded-[14px] border border-primary/25 bg-primary/[0.04] pr-4 pl-12 sm:pr-16",
          "text-row text-foreground transition-colors",
          "placeholder:text-muted-foreground/90",
          "hover:border-primary/40 focus:border-primary/60 focus:bg-primary/[0.06]",
        )}
      />
      {/* The shortcut, stated rather than hidden. Gone on a phone, which has
          no ⌘ and no room. */}
      <kbd
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded-md border border-primary/25 bg-card px-1.5 py-0.5 text-label font-semibold text-muted-foreground sm:block"
      >
        ⌘K
      </kbd>

      {open ? (
        <div
          id="global-search-results"
          // Suppressing mousedown keeps focus in the input, so the click that
          // follows always lands on the link instead of on a panel that has
          // already been torn down.
          onMouseDown={(event) => event.preventDefault()}
          className="absolute top-14 right-0 left-0 z-40 max-h-[70vh] overflow-y-auto rounded-[16px] border bg-popover p-2 shadow-lg"
        >
          {groups.map((group) => (
            <div key={group.label} className="mb-2 last:mb-0">
              <p className="label-caps px-2 pb-1 text-muted-foreground">{group.label}</p>
              {group.rows.map((row) => {
                const isActive = flat[active]?.id === row.id;
                return (
                  <Link
                    key={row.id}
                    href={row.href}
                    onClick={close}
                    onMouseEnter={() => setActive(flat.findIndex((candidate) => candidate.id === row.id))}
                    className={cn(
                      "flex items-baseline gap-2 rounded-[10px] px-2 py-2 text-row transition-colors",
                      isActive ? "bg-primary-soft text-primary" : "hover:bg-muted",
                    )}
                  >
                    <span className="min-w-0 truncate font-medium">{row.label}</span>
                    {row.hint ? <span className="shrink-0 text-meta text-muted-foreground">{row.hint}</span> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
