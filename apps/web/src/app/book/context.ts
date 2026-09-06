import { findLeadByBookingToken, resolveBookingHost } from "@launchos/core";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { getClientSession } from "@/lib/portal-session";
import { publicOrganisationId } from "@/lib/public-organisation";

/**
 * Who is booking, resolved on the server from things the browser cannot
 * forge: a lead's booking token (from the acknowledgement email's link) or a
 * signed-in portal session. Neither an id nor an address ever travels in the
 * URL — the token is looked up, the session is read from the cookie, and a
 * stranger gets the one public organisation.
 */
export type BookingContext = {
  organisationId: string;
  leadId: string | null;
  clientId: string | null;
  /** The signed-in portal user, when the booking is theirs; the meeting's actor. */
  actorId: string | null;
  /** Pre-filled and editable; the guest is whoever they type. */
  name: string;
  email: string;
  /** The token to carry through the form so the confirm files the meeting under the same lead. */
  leadToken: string | null;
  source: "public" | "portal" | "email_link";
};

/** The context for a request, or null when there is no organisation to book with at all. */
export async function resolveBookingContext(leadToken: string | null): Promise<BookingContext | null> {
  const db = getDb();
  if (leadToken) {
    const lead = await findLeadByBookingToken(db, leadToken);
    if (lead) {
      return {
        organisationId: lead.organisationId,
        leadId: lead.id,
        clientId: lead.clientId,
        actorId: null,
        name: lead.name,
        email: lead.email ?? "",
        leadToken,
        source: "email_link",
      };
    }
  }

  const session = await getClientSession();
  if (session) {
    return {
      organisationId: session.organisationId,
      leadId: null,
      clientId: session.clientId,
      actorId: session.userId,
      name: session.name,
      email: session.email,
      leadToken: null,
      source: "portal",
    };
  }

  const organisationId = await publicOrganisationId();
  if (!organisationId) return null;
  return { organisationId, leadId: null, clientId: null, actorId: null, name: "", email: "", leadToken: null, source: "public" };
}

/**
 * The host's first name and zone for the page's "Shoji's time" label. One
 * organisation today, so the name is read rather than assumed — the same
 * page will serve a second tenant's host without an edit.
 */
export async function bookingHostLabel(organisationId: string): Promise<{ firstName: string; timezone: string }> {
  const db = getDb();
  const { settings, hostUserId } = await resolveBookingHost(db, organisationId);
  const [host] = await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, hostUserId)).limit(1);
  const firstName = host?.name?.trim().split(/\s+/)[0] || "Our";
  return { firstName, timezone: settings.timezone };
}
