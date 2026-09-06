import { schema } from "@launchos/db";
import { asc, eq } from "drizzle-orm";
import { getDb } from "./db";

/**
 * The organisation a public, unauthenticated entry point belongs to: the
 * website lead form and the self-serve signup carry no session and no
 * tenancy of their own, so they land on the oldest active organisation —
 * the single-tenant v1 rule the inbound email webhook already applies.
 *
 * Read from the database rather than configured, so selling this as SaaS
 * later means replacing one function (a host → organisation map, say)
 * rather than hunting for a hard-coded id. Null when no organisation is
 * active, which every caller turns into a 503 or a closed page.
 */
export async function publicOrganisationId(): Promise<string | null> {
  const [org] = await getDb()
    .select({ id: schema.organisations.id })
    .from(schema.organisations)
    .where(eq(schema.organisations.status, "active"))
    .orderBy(asc(schema.organisations.createdAt))
    .limit(1);
  return org?.id ?? null;
}
