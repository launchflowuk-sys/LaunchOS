import { schema } from "@launchos/db";
import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "./db";
import { getAuthUser, getSession } from "./session";

export type ClientSession = {
  userId: string;
  email: string;
  name: string;
  organisationId: string;
  clientId: string;
  clientName: string;
  role: "client_admin" | "client_member";
};

/** Query string the sign-in page turns into "your access has been removed". */
export const ACCESS_REVOKED = "access-revoked";

/**
 * The signed-in portal session. A client user belongs to exactly one client in
 * v1; when a user somehow has more than one row the oldest wins so the result
 * is deterministic. Staff sessions never resolve here, and portal users never
 * resolve through `getSession` — the two route groups cannot see each other.
 *
 * Three status columns gate it, and all three are how access is taken away:
 * the `client_users` row itself (suspended by staff), the client (archived on
 * offboarding) and the organisation. None of them requires deleting a `user`
 * row, which would cascade away the audit trail's actor.
 *
 * `cache()` scopes the result to one render pass, so the portal layout and the
 * page inside it resolve the session once rather than twice.
 */
export const getClientSession = cache(async (): Promise<ClientSession | null> => {
  const u = await getAuthUser();
  if (!u) return null;
  const [row] = await getDb()
    .select({
      organisationId: schema.clientUsers.organisationId,
      clientId: schema.clientUsers.clientId,
      role: schema.clientUsers.role,
      clientName: schema.clients.name,
    })
    .from(schema.clientUsers)
    .innerJoin(schema.clients, eq(schema.clientUsers.clientId, schema.clients.id))
    .innerJoin(schema.organisations, eq(schema.clientUsers.organisationId, schema.organisations.id))
    .where(
      and(
        eq(schema.clientUsers.userId, u.id),
        eq(schema.clientUsers.status, "active"),
        // `paused` is a commercial state, not a security one — a paused client
        // keeps their portal. `archived` is offboarded and must lose it.
        ne(schema.clients.status, "archived"),
        eq(schema.organisations.status, "active"),
      ),
    )
    .orderBy(schema.clientUsers.createdAt)
    .limit(1);
  if (!row) return null;
  return { userId: u.id, email: u.email, name: u.name, ...row };
});

/**
 * True when this user has a portal row at all. Only ever called after
 * `getClientSession` has already returned null, so the row that exists is by
 * definition one the gate refused — suspended, archived client, or an
 * organisation that has been switched off. The distinction is worth one extra
 * query on the failure path: otherwise somebody whose access was removed keeps
 * retrying a password that was never the problem.
 */
async function hasRevokedPortalAccess(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: schema.clientUsers.id })
    .from(schema.clientUsers)
    .where(eq(schema.clientUsers.userId, userId))
    .limit(1);
  return !!row;
}

/**
 * Gate for every portal page and server action.
 *
 * Staff are checked first and sent to the admin shell: it is the more capable
 * surface, and it is the same precedence `/after-sign-in` applies, so a user
 * who somehow holds both kinds of membership always lands in the same place.
 * Anyone else is not signed in as far as the portal is concerned.
 */
export async function requireClient(): Promise<ClientSession> {
  if (await getSession()) redirect("/");
  const s = await getClientSession();
  if (s) return s;

  const u = await getAuthUser();
  if (u && (await hasRevokedPortalAccess(u.id))) redirect(`/sign-in?reason=${ACCESS_REVOKED}`);
  redirect("/sign-in");
}
