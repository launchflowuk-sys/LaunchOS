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
