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
  /** Whether this account has a second factor on it. */
  twoFactorEnabled: boolean;
  /** Whether this organisation requires one of its owner and staff accounts. */
  twoFactorRequired: boolean;
};

/**
 * Where a member who owes an enrolment is sent. Everything to do with a second
 * factor lives on the Account screen, so the gate points at the screen that
 * fixes it rather than at a dead end, and the query string is what turns the
 * notice on when they arrive.
 */
export const ENROL_TWO_FACTOR = "/account?two-factor=required";

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
      twoFactorRequired: schema.organisations.requireStaffTwoFactor,
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
  // `twoFactorEnabled` rides on the Better Auth user the plugin extends, so
  // the enrolment state costs no query of its own.
  return { userId: u.id, email: u.email, twoFactorEnabled: u.twoFactorEnabled === true, ...m };
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

/**
 * The gate on every admin page and server action.
 *
 * `allowPendingEnrolment` is for the two places that must stay reachable when
 * an organisation requires a second factor and this member has not set one up
 * yet: the Account screen, which is where they set it up, and the shell that
 * renders it. Everything else redirects there — which is what makes the
 * organisation setting an enforcement rather than a suggestion, and why a
 * hidden nav link was never the mechanism.
 *
 * Enforcement is off until an owner deliberately switches it on, and
 * `setStaffTwoFactorRequired` refuses to let an unenrolled owner switch it on
 * at all. Between them, no migration and no deploy can shut anybody out of a
 * live system.
 */
export async function requireAdmin(options?: { allowPendingEnrolment?: boolean }): Promise<AdminSession> {
  const s = await getSession();
  if (s) {
    if (s.twoFactorRequired && !s.twoFactorEnabled && !options?.allowPendingEnrolment) redirect(ENROL_TWO_FACTOR);
    return s;
  }
  // A client user who follows a link into the admin shell belongs in the
  // portal, not back at the sign-in form they have already passed.
  const u = await getAuthUser();
  if (u && (await hasPortalAccount(u.id))) redirect("/portal");
  redirect("/sign-in");
}
