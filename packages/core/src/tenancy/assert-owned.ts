import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, getTableName } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

/**
 * Ownership guards for ids that arrive from outside the trust boundary — an
 * agent's tool input, an API body, a form post. Every domain write that takes
 * a foreign key it did not itself look up asserts first, so a caller cannot
 * reach across organisations by guessing or replaying an id.
 */
export type OwnedTable = PgTable & { id: PgColumn; organisationId: PgColumn };

/** "billing_profiles" → "billing_profile", "clients" → "client". */
function subjectOf(table: OwnedTable): string {
  const name = getTableName(table);
  return name.endsWith("s") ? name.slice(0, -1) : name;
}

export async function assertOwned(db: Db, organisationId: string, table: OwnedTable, id: string): Promise<void> {
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.organisationId, organisationId)))
    .limit(1);
  if (!row) throw new Error(`${subjectOf(table)} ${id} not found in organisation`);
}

export async function assertClientInOrganisation(db: Db, organisationId: string, clientId: string): Promise<void> {
  await assertOwned(db, organisationId, schema.clients, clientId);
}

export async function assertSiteInOrganisation(db: Db, organisationId: string, siteId: string): Promise<void> {
  await assertOwned(db, organisationId, schema.sites, siteId);
}

/**
 * `siteId` is only asserted against the organisation by `assertOwned`, which
 * would let client A's task (or domain) point at client B's site as long as
 * both sites live in the same org. Call after `assertSiteInOrganisation` has
 * already confirmed the site is in this organisation.
 */
export async function assertSiteBelongsToClient(db: Db, organisationId: string, siteId: string, clientId: string): Promise<void> {
  const [site] = await db
    .select({ clientId: schema.sites.clientId })
    .from(schema.sites)
    .where(and(eq(schema.sites.id, siteId), eq(schema.sites.organisationId, organisationId)));
  if (site && site.clientId !== clientId) throw new Error(`site ${siteId} belongs to another client`);
}

/**
 * `ticketId` is only asserted against the organisation by `assertOwned`, which
 * would let a task (or anything else) pair a ticket from client A with client
 * B's id as long as both are in the same organisation. Mirrors
 * `assertSiteBelongsToClient`: call after the ticket is already known to be in
 * this organisation.
 */
export async function assertTicketBelongsToClient(db: Db, organisationId: string, ticketId: string, clientId: string): Promise<void> {
  const [ticket] = await db
    .select({ clientId: schema.tickets.clientId })
    .from(schema.tickets)
    .where(and(eq(schema.tickets.id, ticketId), eq(schema.tickets.organisationId, organisationId)));
  if (ticket && ticket.clientId !== clientId) throw new Error(`ticket ${ticketId} belongs to another client`);
}

/**
 * `invoiceId` is only asserted against the organisation by `assertOwned`, which
 * would let a payment for client A settle client B's invoice as long as both
 * are in the same organisation. Mirrors `assertSiteBelongsToClient`: call after
 * the invoice is already known to be in this organisation.
 */
export async function assertInvoiceBelongsToClient(db: Db, organisationId: string, invoiceId: string, clientId: string): Promise<void> {
  const [invoice] = await db
    .select({ clientId: schema.invoices.clientId })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.organisationId, organisationId)));
  if (invoice && invoice.clientId !== clientId) throw new Error(`invoice ${invoiceId} belongs to another client`);
}

/** Guards a notification/mention target: the userId must be an active member of the organisation. */
export async function assertOrgMember(db: Db, organisationId: string, userId: string): Promise<void> {
  const [row] = await db
    .select({ id: schema.organisationMembers.id })
    .from(schema.organisationMembers)
    .where(
      and(
        eq(schema.organisationMembers.organisationId, organisationId),
        eq(schema.organisationMembers.userId, userId),
        eq(schema.organisationMembers.status, "active"),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`member ${userId} not found in organisation`);
}
