import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";

export type ClientUserRow = {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: "client_admin" | "client_member";
  status: "active" | "suspended";
  createdAt: Date;
  /** Whether this portal account holds a second factor. Drives the reset control. */
  twoFactorEnabled: boolean;
};

/**
 * Portal accounts for one client, oldest first. Filtered on the organisation as
 * well as the client so a guessed client id from another tenant returns nothing
 * rather than that tenant's people.
 */
export async function listClientUsers(db: Db, organisationId: string, clientId: string): Promise<ClientUserRow[]> {
  return db
    .select({
      id: schema.clientUsers.id,
      userId: schema.clientUsers.userId,
      email: schema.user.email,
      name: schema.user.name,
      role: schema.clientUsers.role,
      status: schema.clientUsers.status,
      createdAt: schema.clientUsers.createdAt,
      twoFactorEnabled: schema.user.twoFactorEnabled,
    })
    .from(schema.clientUsers)
    .innerJoin(schema.user, eq(schema.clientUsers.userId, schema.user.id))
    .where(and(eq(schema.clientUsers.organisationId, organisationId), eq(schema.clientUsers.clientId, clientId)))
    .orderBy(asc(schema.clientUsers.createdAt));
}
