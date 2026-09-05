import Link from "next/link";

/** One screenful. Lists fetch `PAGE_SIZE + 1` rows to learn whether more exist. */
export const PAGE_SIZE = 50;

/** A hand-edited `?page=` cannot ask Postgres to skip a billion rows. */
const MAX_PAGE = 1000;

/**
 * Reads a 1-based `?page=` from a search param. Anything that is not a whole
 * number in range — a word, a negative, a float, an absurd offset — is page 1,
 * so the list narrows wrongly at worst and never 500s.
 */
export function pageParam(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_PAGE ? n : 1;
}

type Query = Readonly<Record<string, string | undefined>>;

/** Drops empty values so the "Newer" link back to page 1 has no `page=` at all. */
function withPage(query: Query, page: number | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key !== "page" && value !== undefined && value.length > 0) out[key] = value;
  }
  if (page && page > 1) out.page = String(page);
  return out;
}

// Under `sm` the two controls stack and fill the width, the way the page
// header's primary action and the toolbar's fields do: a 72px link floating at
// the left edge under a full-width list of row cards reads as a stray word.
const BASE = "block rounded-md border px-3 py-2 text-center text-sm sm:inline-block sm:py-1.5";
const LINK = `${BASE} bg-card text-foreground transition-colors hover:bg-muted`;
const DISABLED = `${BASE} text-muted-foreground opacity-50`;

/**
 * Newer / Older links that carry the current filters. Deliberately offset-based
 * rather than a keyset cursor: these lists are ordered by a timestamp that is
 * not unique, and an operator paging through fifty rows at a time does not need
 * the stability a cursor buys.
 */
export function Pager({
  basePath,
  query,
  page,
  hasNext,
}: {
  /** Typed-routes literal, so a pager can never point at a route that is gone. */
  basePath: "/inbox" | "/cases" | "/tasks" | "/approvals" | "/clients" | "/content";
  query: Query;
  page: number;
  hasNext: boolean;
}) {
  if (page === 1 && !hasNext) return null;

  return (
    <nav aria-label="Pagination" className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
      {page > 1 ? (
        <Link href={{ pathname: basePath, query: withPage(query, page - 1) }} className={LINK}>
          Newer
        </Link>
      ) : (
        <span className={DISABLED}>Newer</span>
      )}
      <span className="text-center text-sm tabular-nums text-muted-foreground">Page {page}</span>
      {hasNext ? (
        <Link href={{ pathname: basePath, query: withPage(query, page + 1) }} className={LINK}>
          Older
        </Link>
      ) : (
        <span className={DISABLED}>Older</span>
      )}
    </nav>
  );
}
