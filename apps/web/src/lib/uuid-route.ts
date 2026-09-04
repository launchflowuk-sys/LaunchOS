import { notFound } from "next/navigation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A dynamic segment that must be a UUID before it reaches Postgres.
 *
 * `where id = 'not-a-uuid'` against a `uuid` column raises 22P02, which Next
 * renders as its error page — a malformed URL is a 404, not a 500. Call this
 * on the awaited param before the first query.
 */
export function uuidOr404(id: string): string {
  if (!UUID.test(id)) notFound();
  return id;
}
