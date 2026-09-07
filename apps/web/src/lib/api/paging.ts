/**
 * The paging and filter parsing every `/api/v1` list route shares.
 *
 * One place, because five routes each writing their own `Number(...)` is five
 * chances to disagree about what `?limit=abc` means — and a caller that gets
 * silently given 50 rows when it asked for 500 has no way to notice.
 */

/** The core services cap at 200; asking for more is a mistake worth naming rather than trimming. */
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

export type Paging = { readonly ok: true; readonly limit: number; readonly offset: number } | { readonly ok: false; readonly message: string };

export function parsePaging(params: URLSearchParams): Paging {
  const limit = parseBounded(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (limit === null) return { ok: false, message: `limit must be a whole number between 1 and ${MAX_LIMIT}` };

  const offset = parseBounded(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  if (offset === null) return { ok: false, message: "offset must be a whole number of 0 or more" };

  return { ok: true, limit, offset };
}

function parseBounded(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

/**
 * A query parameter constrained to a known set.
 *
 * Absent is fine and means "no filter". Present but unrecognised is refused
 * rather than ignored: `?status=pendign` silently returning every row is how a
 * caller comes to believe a filter is applied when it is not, and acts on the
 * wrong list.
 */
export function parseEnumParam<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): { ok: true; value: T | undefined } | { ok: false; message: string } {
  if (raw === null || raw === "") return { ok: true, value: undefined };
  if ((allowed as readonly string[]).includes(raw)) return { ok: true, value: raw as T };
  return { ok: false, message: `unknown value "${raw}" — expected one of: ${allowed.join(", ")}` };
}
