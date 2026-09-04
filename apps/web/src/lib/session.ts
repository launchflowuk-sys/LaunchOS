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

/**
 * True when the signed-in user holds a portal account in an active
 * organisation. Queried here rather than through `getClientSession` so
 * `session.ts` stays free of an import cycle with `portal-session.ts`, which
 * needs `getSession` for the opposite redirect.
 */
async function hasPortalAccount(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: schema.clientUsers.id })
    .from(schema.clientUsers)
    .innerJoin(schema.organisations, eq(schema.clientUsers.organisationId, schema.organisations.id))
    .where(and(eq(schema.clientUsers.userId, userId), eq(schema.organisations.status, "active")))
    .limit(1);
  return !!row;
}

export async function requireAdmin(): Promise<AdminSession> {
  const s = await getSession();
  if (s) return s;
  // A client user who follows a link into the admin shell belongs in the
  // portal, not back at the sign-in form they have already passed.
  const auth = await getAuth().api.getSession({ headers: await headers() });
  if (auth && (await hasPortalAccount(auth.user.id))) redirect("/portal");
  redirect("/sign-in");
}
