import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, ilike, or } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { escapeLike } from "../clients/list-clients.js";

export const SearchInput = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(20).default(5),
});
export type SearchInput = z.input<typeof SearchInput>;

export type SearchResults = {
  clients: { id: string; name: string; slug: string }[];
  sites: { id: string; name: string; primaryUrl: string }[];
  domains: { id: string; name: string }[];
  tickets: { id: string; subject: string; status: string }[];
  tasks: { id: string; title: string; status: string }[];
};

type OrgScopedTable = PgTable & { organisationId: PgColumn };

/**
 * The WHERE clause shared by every kind below: organisation-scoped, ILIKE
 * across one or more columns for the same term. Extracted so the five kinds
 * (clients/sites/domains/tickets/tasks) don't each repeat
 * `and(eq(table.organisationId, ...), or(ilike(...), ...))`.
 */
function matchesInOrg(table: OrgScopedTable, organisationId: string, term: string, columns: PgColumn[]) {
  return and(eq(table.organisationId, organisationId), or(...columns.map((column) => ilike(column, term))));
}

/**
 * Header search: name/subject/title ILIKE, organisation-scoped, a handful of
 * rows per kind. Knowledge articles join this in Plan 4.
 */
export async function search(db: Db, organisationId: string, input: SearchInput): Promise<SearchResults> {
  const v = SearchInput.parse(input);
  const term = `%${escapeLike(v.q)}%`;

  const [clients, sites, domains, tickets, tasks] = await Promise.all([
    db
      .select({ id: schema.clients.id, name: schema.clients.name, slug: schema.clients.slug })
      .from(schema.clients)
      .where(matchesInOrg(schema.clients, organisationId, term, [schema.clients.name, schema.clients.slug, schema.clients.email]))
      .orderBy(schema.clients.name)
      .limit(v.limit),
    db
      .select({ id: schema.sites.id, name: schema.sites.name, primaryUrl: schema.sites.primaryUrl })
      .from(schema.sites)
      .where(matchesInOrg(schema.sites, organisationId, term, [schema.sites.name, schema.sites.primaryUrl]))
      .orderBy(schema.sites.name)
      .limit(v.limit),
    db
      .select({ id: schema.domains.id, name: schema.domains.name })
      .from(schema.domains)
      .where(matchesInOrg(schema.domains, organisationId, term, [schema.domains.name]))
      .orderBy(schema.domains.name)
      .limit(v.limit),
    db
      .select({ id: schema.tickets.id, subject: schema.tickets.subject, status: schema.tickets.status })
      .from(schema.tickets)
      .where(matchesInOrg(schema.tickets, organisationId, term, [schema.tickets.subject]))
      .orderBy(schema.tickets.subject)
      .limit(v.limit),
    db
      .select({ id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status })
      .from(schema.tasks)
      .where(matchesInOrg(schema.tasks, organisationId, term, [schema.tasks.title]))
      .orderBy(schema.tasks.title)
      .limit(v.limit),
  ]);

  return { clients, sites, domains, tickets, tasks };
}
