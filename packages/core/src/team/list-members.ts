import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { MemberPermissions } from "@launchos/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { resolvePermissions } from "./permissions.js";

export type MemberRow = {
  id: string;
  userId: string;
  email: string;
  name: string;
  displayName: string | null;
  title: string | null;
  phone: string | null;
  role: "owner" | "staff";
  status: "active" | "invited" | "suspended";
  initialPasswordSetAt: Date | null;
  createdAt: Date;
  /** Whether this member's account holds a second factor. Drives the reset control. */
  twoFactorEnabled: boolean;
  /** What the member may do, resolved: an owner always has all five. */
  permissions: MemberPermissions;
};

export async function listMembers(db: Db, organisationId: string): Promise<MemberRow[]> {
  const rows = await db
    .select({
      id: schema.organisationMembers.id,
      userId: schema.organisationMembers.userId,
      email: schema.user.email,
      name: schema.user.name,
      displayName: schema.organisationMembers.displayName,
      title: schema.organisationMembers.title,
      phone: schema.organisationMembers.phone,
      role: schema.organisationMembers.role,
      status: schema.organisationMembers.status,
      initialPasswordSetAt: schema.organisationMembers.initialPasswordSetAt,
      createdAt: schema.organisationMembers.createdAt,
      twoFactorEnabled: schema.user.twoFactorEnabled,
      stored: schema.organisationMembers.permissions,
    })
    .from(schema.organisationMembers)
    .innerJoin(schema.user, eq(schema.organisationMembers.userId, schema.user.id))
    .where(eq(schema.organisationMembers.organisationId, organisationId))
    .orderBy(asc(schema.organisationMembers.createdAt));
  return rows.map(({ stored, ...row }) => ({ ...row, permissions: resolvePermissions(row.role, stored) }));
}

/** Active owners, used to stop the last one being locked out. */
export async function countActiveOwners(db: Db, organisationId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.organisationMembers.id })
    .from(schema.organisationMembers)
    .where(
      and(
        eq(schema.organisationMembers.organisationId, organisationId),
        eq(schema.organisationMembers.role, "owner"),
        eq(schema.organisationMembers.status, "active"),
      ),
    );
  return rows.length;
}
