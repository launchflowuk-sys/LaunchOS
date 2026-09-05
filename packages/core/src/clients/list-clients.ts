import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";

export const ListClientsInput = z.object({
  query: z.string().trim().max(100).optional(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  limit: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().min(0).default(0),
  // Most callers build a picker — a dropdown of every client — where the only
  // useful order is the one you can scan for a name, so alphabetical is the
  // default. The paged /clients page asks for "recent" instead: a client added
  // a moment ago belongs on page 1, not wherever the alphabet puts it.
  order: z.enum(["recent", "name"]).default("name"),
});
export type ListClientsInput = z.input<typeof ListClientsInput>;

/** Postgres LIKE treats % _ \ as metacharacters; user text must not. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export type ClientListRow = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "paused" | "archived";
  email: string | null;
  phone: string | null;
  supportEmail: string | null;
  createdAt: Date;
  siteCount: number;
  domainCount: number;
};

export async function listClients(
  db: Db,
  organisationId: string,
  input: ListClientsInput = {},
): Promise<ClientListRow[]> {
  const v = ListClientsInput.parse(input);
  const term = v.query ? `%${escapeLike(v.query)}%` : undefined;

  // Per-client counts are pre-aggregated in their own subqueries and left-joined
  // in: a correlated subquery referencing the outer `clients.id` bare (e.g.
  // `where site.client_id = id`) is ambiguous once the inner table also has an
  // `id` column (every table here does via tenantColumns), and Drizzle does not
  // table-qualify that reference — it silently resolves to the inner table's
  // own id, so every count comes back 0. The join form has no such ambiguity.
  const siteCounts = db
    .select({ clientId: schema.sites.clientId, count: sql<number>`count(*)::int`.as("site_count") })
    .from(schema.sites)
    .groupBy(schema.sites.clientId)
    .as("site_counts");
  const domainCounts = db
    .select({ clientId: schema.domains.clientId, count: sql<number>`count(*)::int`.as("domain_count") })
    .from(schema.domains)
    .groupBy(schema.domains.clientId)
    .as("domain_counts");

  return db
    .select({
      id: schema.clients.id,
      name: schema.clients.name,
      slug: schema.clients.slug,
      status: schema.clients.status,
      email: schema.clients.email,
      phone: schema.clients.phone,
      supportEmail: schema.clients.supportEmail,
      createdAt: schema.clients.createdAt,
      siteCount: sql<number>`coalesce(${siteCounts.count}, 0)`,
      domainCount: sql<number>`coalesce(${domainCounts.count}, 0)`,
    })
    .from(schema.clients)
    .leftJoin(siteCounts, eq(siteCounts.clientId, schema.clients.id))
    .leftJoin(domainCounts, eq(domainCounts.clientId, schema.clients.id))
    .where(
      and(
        eq(schema.clients.organisationId, organisationId),
        v.status ? eq(schema.clients.status, v.status) : undefined,
        term
          ? or(
              ilike(schema.clients.name, term),
              ilike(schema.clients.slug, term),
              ilike(schema.clients.email, term),
              ilike(schema.clients.supportEmail, term),
            )
          : undefined,
      ),
    )
    // `id` breaks either tie: `created_at` defaults to `now()`, which is the
    // transaction timestamp, so a batch inserted together shares one, and two
    // clients can share a name — without a total order an offset page can
    // repeat or skip a row.
    .orderBy(
      ...(v.order === "recent"
        ? [desc(schema.clients.createdAt), desc(schema.clients.id)]
        : [asc(schema.clients.name), asc(schema.clients.id)]),
    )
    .limit(v.limit)
    .offset(v.offset);
}

export async function getClient(db: Db, organisationId: string, clientId: string) {
  const [row] = await db
    .select()
    .from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId)));
  return row ?? null;
}
