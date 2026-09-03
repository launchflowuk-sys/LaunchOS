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
 * Returns null when nobody is signed in or the user is not an active member
 * of an organisation (client-portal users never reach the admin screens).
 */
export async function getSession(): Promise<AdminSession | null> {
  const s = await getAuth().api.getSession({ headers: await headers() });
  if (!s) return null;
  const [m] = await getDb()
    .select()
    .from(schema.organisationMembers)
    .where(
      and(
        eq(schema.organisationMembers.userId, s.user.id),
        eq(schema.organisationMembers.status, "active"),
      ),
    );
  if (!m) return null;
  return { userId: s.user.id, email: s.user.email, organisationId: m.organisationId, role: m.role };
}

export async function requireAdmin(): Promise<AdminSession> {
  const s = await getSession();
  if (!s) redirect("/sign-in");
  return s;
}
