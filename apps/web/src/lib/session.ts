import { schema } from "@launchos/db";
import { and, eq, ne } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth } from "./auth";
import { getDb } from "./db";

export type AdminSession = {
  userId: string;
  email: string;
  organisationId: string;
  role: "owner" | "staff";
};

/**
 * The Better Auth user behind the request cookie, or null.
 *
 * `cache()` scopes the result to one render pass, so the layout, the page and
 * every server action inside it share a single auth lookup instead of one each.
 */
export const getAuthUser = cache(async () => {
  const s = await getAuth().api.getSession({ headers: await headers() });
  return s?.user ?? null;
});

/**
 * The signed-in staff session plus the organisation it belongs to.
 * Returns null when nobody is signed in, the user is not an active member of
 * an organisation (client-portal users never reach the admin screens), or
 * that organisation itself is not active. When a user has more than one
 * active membership, the oldest one wins so the result is deterministic.
 * Cached per request for the same reason as `getAuthUser`.
 */
export const getSession = cache(async (): Promise<AdminSession | null> => {
  const u = await getAuthUser();
  if (!u) return null;
  const [m] = await getDb()
    .select({
      organisationId: schema.organisationMembers.organisationId,
      role: schema.organisationMembers.role,
    })
    .from(schema.organisationMembers)
    .innerJoin(schema.organisations, eq(schema.organisationMembers.organisationId, schema.organisations.id))
    .where(
      and(
        eq(schema.organisationMembers.userId, u.id),
        eq(schema.organisationMembers.status, "active"),
        eq(schema.organisations.status, "active"),
      ),
    )
    .orderBy(schema.organisationMembers.createdAt)
    .limit(1);
  if (!m) return null;
  return { userId: u.id, email: u.email, organisationId: m.organisationId, role: m.role };
});

/**
 * True when the signed-in user holds a *usable* portal account: an active
 * `client_users` row, on a client that has not been archived, in an active
 * organisation. The same three conditions `getClientSession` applies — a
 * suspended user bounced to `/portal` would only be bounced back to
 * `/sign-in`, which reads as a loop rather than as revoked access.
 *
 * Queried here rather than through `getClientSession` so `session.ts` stays
 * free of an import cycle with `portal-session.ts`, which needs `getSession`
 * for the opposite redirect.
 */
async function hasPortalAccount(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: schema.clientUsers.id })
    .from(schema.clientUsers)
    .innerJoin(schema.clients, eq(schema.clientUsers.clientId, schema.clients.id))
    .innerJoin(schema.organisations, eq(schema.clientUsers.organisationId, schema.organisations.id))
    .where(
      and(
        eq(schema.clientUsers.userId, userId),
        eq(schema.clientUsers.status, "active"),
        ne(schema.clients.status, "archived"),
        eq(schema.organisations.status, "active"),
      ),
    )
    .limit(1);
  return !!row;
}

export async function requireAdmin(): Promise<AdminSession> {
  const s = await getSession();
  if (s) return s;
  // A client user who follows a link into the admin shell belongs in the
  // portal, not back at the sign-in form they have already passed.
  const u = await getAuthUser();
  if (u && (await hasPortalAccount(u.id))) redirect("/portal");
  redirect("/sign-in");
}
