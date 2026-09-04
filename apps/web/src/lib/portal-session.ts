import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth";
import { getDb } from "./db";
import { getSession } from "./session";

export type ClientSession = {
  userId: string;
  email: string;
  name: string;
  organisationId: string;
  clientId: string;
  clientName: string;
  role: "client_admin" | "client_member";
};

/**
 * The signed-in portal session. A client user belongs to exactly one client in
 * v1; when a user somehow has more than one row the oldest wins so the result
 * is deterministic. Staff sessions never resolve here, and portal users never
 * resolve through `getSession` — the two route groups cannot see each other.
 */
export async function getClientSession(): Promise<ClientSession | null> {
  const s = await getAuth().api.getSession({ headers: await headers() });
  if (!s) return null;
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
    .where(and(eq(schema.clientUsers.userId, s.user.id), eq(schema.organisations.status, "active")))
    .orderBy(schema.clientUsers.createdAt)
    .limit(1);
  if (!row) return null;
  return { userId: s.user.id, email: s.user.email, name: s.user.name, ...row };
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
  if (!s) redirect("/sign-in");
  return s;
}
