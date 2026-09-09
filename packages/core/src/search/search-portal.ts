import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, ilike, ne, or } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { escapeLike } from "../clients/list-clients.js";

/**
 * The portal's search — and the reason it is not `search()`.
 *
 * `search()` is scoped to an *organisation*, and an organisation holds every
 * client. Pointing the portal's box at it would have shown one client another
 * client's websites, domains and support requests for the price of typing
 * three letters. So this exists as its own function with the client id as a
 * required argument rather than an option, because an optional filter is one
 * someone eventually forgets to pass.
 *
 * The second rule is subtler and is why this does not simply add
 * `client_id = ?` to the admin's query: **a client must not be able to find by
 * searching what they cannot reach by clicking.** Three of the six kinds carry
 * a visibility rule that the portal's own screens already apply — internal
 * tickets, internal tasks, draft invoices — and each one is repeated here
 * deliberately rather than inherited, because a search that quietly ignored
 * them would be a disclosure bug that no screen could show you.
 */

export const PortalSearchInput = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(20).default(5),
});
export type PortalSearchInput = z.input<typeof PortalSearchInput>;

export type PortalSearchResults = {
  sites: { id: string; name: string; status: string }[];
  domains: { id: string; name: string }[];
  requests: { id: string; subject: string; status: string }[];
  tasks: { id: string; title: string; status: string }[];
  invoices: { id: string; number: string; status: string }[];
  documents: { id: string; title: string; reference: string }[];
};

/** Empty in the same shape, so a refusal and a genuine miss are indistinguishable to the caller. */
const NOTHING: PortalSearchResults = { sites: [], domains: [], requests: [], tasks: [], invoices: [], documents: [] };

/**
 * Both scopes at once. Every query below starts here, so there is no way to
 * write one that filters by organisation and forgets the client.
 */
function ownedBy(
  table: { organisationId: PgColumn; clientId: PgColumn },
  organisationId: string,
  clientId: string,
  term: string,
  columns: PgColumn[],
) {
  return and(
    eq(table.organisationId, organisationId),
    eq(table.clientId, clientId),
    or(...columns.map((column) => ilike(column, term))),
  );
}

export async function searchPortal(
  db: Db,
  organisationId: string,
  clientId: string,
  input: PortalSearchInput,
): Promise<PortalSearchResults> {
  const v = PortalSearchInput.parse(input);
  const term = `%${escapeLike(v.q)}%`;

  const [sites, domains, requests, tasks, invoices, documents] = await Promise.all([
    db
      .select({ id: schema.sites.id, name: schema.sites.name, status: schema.sites.status })
      .from(schema.sites)
      .where(ownedBy(schema.sites, organisationId, clientId, term, [schema.sites.name, schema.sites.primaryUrl]))
      .orderBy(schema.sites.name)
      .limit(v.limit),
    db
      .select({ id: schema.domains.id, name: schema.domains.name })
      .from(schema.domains)
      .where(ownedBy(schema.domains, organisationId, clientId, term, [schema.domains.name]))
      .orderBy(schema.domains.name)
      .limit(v.limit),
    db
      .select({ id: schema.tickets.id, subject: schema.tickets.subject, status: schema.tickets.status })
      .from(schema.tickets)
      // `client_visible` is not optional: the overdue sweep opens a ticket per
      // unpaid invoice and an agent's `tickets_create` is internal by design.
      // Both are this client's by `client_id`; neither is theirs to read.
      .where(and(
        ownedBy(schema.tickets, organisationId, clientId, term, [schema.tickets.subject]),
        eq(schema.tickets.clientVisible, true),
      ))
      .orderBy(schema.tickets.subject)
      .limit(v.limit),
    db
      .select({ id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status })
      .from(schema.tasks)
      .where(and(
        ownedBy(schema.tasks, organisationId, clientId, term, [schema.tasks.title]),
        eq(schema.tasks.clientVisible, true),
      ))
      .orderBy(schema.tasks.title)
      .limit(v.limit),
    db
      .select({ id: schema.invoices.id, number: schema.invoices.number, status: schema.invoices.status })
      .from(schema.invoices)
      // A draft is a figure we are still deciding on. The invoices screen hides
      // them with the same clause; finding one by number would be worse than
      // showing it, because it would arrive with no context at all.
      .where(and(
        ownedBy(schema.invoices, organisationId, clientId, term, [schema.invoices.number]),
        ne(schema.invoices.status, "draft"),
      ))
      .orderBy(schema.invoices.number)
      .limit(v.limit),
    db
      .select({ id: schema.documents.id, title: schema.documents.title, reference: schema.documents.reference })
      .from(schema.documents)
      .where(ownedBy(schema.documents, organisationId, clientId, term, [schema.documents.title, schema.documents.reference]))
      .orderBy(schema.documents.title)
      .limit(v.limit),
  ]);

  return { sites, domains, requests, tasks, invoices, documents };
}

/** Exported for the route handler, which must answer the same shape when it refuses. */
export const PORTAL_SEARCH_EMPTY = NOTHING;
