import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth";
import { getDb } from "./db";

export type AdminSession = {
  userId: string;
  email: string;
  organisationId: string;
  role: "owner" | "staff";
};

/**
 * The signed-in staff session plus the organisation it belongs to.
 * Returns null when nobody is signed in, the user is not an active member of
 * an organisation (client-portal users never reach the admin screens), or
 * that organisation itself is not active. When a user has more than one
 * active membership, the oldest one wins so the result is deterministic.
 */
export async function getSession(): Promise<AdminSession | null> {
  const s = await getAuth().api.getSession({ headers: await headers() });
  if (!s) return null;
  const [m] = await getDb()
    .select({
      organisationId: schema.organisationMembers.organisationId,
      role: schema.organisationMembers.role,
    })
    .from(schema.organisationMembers)
    .innerJoin(schema.organisations, eq(schema.organisationMembers.organisationId, schema.organisations.id))
    .where(
      and(
        eq(schema.organisationMembers.userId, s.user.id),
        eq(schema.organisationMembers.status, "active"),
        eq(schema.organisations.status, "active"),
      ),
    )
    .orderBy(schema.organisationMembers.createdAt)
    .limit(1);
  if (!m) return null;
  return { userId: s.user.id, email: s.user.email, organisationId: m.organisationId, role: m.role };
}

export async function requireAdmin(): Promise<AdminSession> {
  const s = await getSession();
  if (!s) redirect("/sign-in");
  return s;
}
