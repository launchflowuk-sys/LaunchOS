import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, like } from "drizzle-orm";
import { supportEmailDomain } from "../config.js";

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
 * The first free slug for the organisation: "acme", then "acme-2", "acme-3".
 * The slug is the support address's local part, and `clients.support_email`
 * is unique across every organisation (inbound mail is routed by address
 * alone), so a candidate must be free both as this org's slug AND as any
 * organisation's support email local part — otherwise the second org to
 * create, say, "Acme Ltd" would hit the global unique-email constraint.
 */
export async function uniqueClientSlug(
  db: Db,
  organisationId: string,
  desired: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const base = slugify(desired) || "client";
  const domain = supportEmailDomain(env);
  // `base` is already [a-z0-9-] only, so it carries no LIKE metacharacters.
  const [slugRows, emailRows] = await Promise.all([
    db
      .select({ slug: schema.clients.slug })
      .from(schema.clients)
      .where(and(eq(schema.clients.organisationId, organisationId), like(schema.clients.slug, `${base}%`))),
    db
      .select({ supportEmail: schema.clients.supportEmail })
      .from(schema.clients)
      .where(like(schema.clients.supportEmail, `${base}%@${domain}`)),
  ]);
  const takenSlugs = new Set(slugRows.map((r) => r.slug));
  const takenLocalParts = new Set(
    emailRows
      .map((r) => r.supportEmail)
      .filter((email): email is string => !!email && email.endsWith(`@${domain}`))
      .map((email) => email.slice(0, email.length - domain.length - 1)),
  );
  const isFree = (candidate: string) => !takenSlugs.has(candidate) && !takenLocalParts.has(candidate);

  if (isFree(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (isFree(candidate)) return candidate;
  }
  throw new Error(`could not allocate a unique slug for "${desired}"`);
}
