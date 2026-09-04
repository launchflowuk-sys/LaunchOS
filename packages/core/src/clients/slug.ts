import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, like } from "drizzle-orm";

const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "gu");

/** "Grays CabLine" → "grays-cabline". Only [a-z0-9-] survives. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/**
 * The first free slug in the organisation: "acme", then "acme-2", "acme-3".
 * The slug is the support address's local part, so it has to be stable and
 * readable, not a random id.
 */
export async function uniqueClientSlug(db: Db, organisationId: string, desired: string): Promise<string> {
  const base = slugify(desired) || "client";
  // `base` is already [a-z0-9-] only, so it carries no LIKE metacharacters.
  const rows = await db
    .select({ slug: schema.clients.slug })
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), like(schema.clients.slug, `${base}%`)));
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not allocate a unique slug for "${desired}"`);
}
