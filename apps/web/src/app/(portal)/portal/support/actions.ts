"use server";

import { createTicket, replyAsClient } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { requireClient } from "@/lib/portal-session";
import { installWebEnqueue } from "@/lib/queue";
import { firstIssue, NewTicketSchema, ReplySchema, type ActionResult } from "./schemas";

/**
 * Raise a support request from the portal.
 *
 * `clientId` comes from the session, never the form: a portal user cannot
 * raise a ticket against somebody else's client whatever they post.
 */
export async function createPortalTicket(formData: FormData): Promise<ActionResult> {
  const session = await requireClient();
  installWebEnqueue();

  const parsed = NewTicketSchema.safeParse({
    subject: formData.get("subject"),
    body: formData.get("body"),
    severity: formData.get("severity"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const v = parsed.data;

  let ticketId: string;
  try {
    const { ticket } = await createTicket(getDb(), session.organisationId, {
      clientId: session.clientId,
      subject: v.subject,
      body: v.body,
      severity: v.severity,
      source: "portal",
      actorKind: "client",
      actorId: session.userId,
    });
    ticketId = ticket.id;
  } catch (error) {
    console.error("portal ticket creation failed", error);
    return { status: "error", message: "That request could not be raised. Please try again." };
  }

  revalidatePath("/portal/support");
  revalidatePath("/portal");
  // Outside the try: `redirect` signals by throwing, so catching it here would
  // turn a successful submit into an error message.
  redirect(`/portal/support/${ticketId}`);
}

/**
 * Append a client reply to their own ticket's thread.
 *
 * `replyAsClient` writes it the way an emailed reply is written — `inbound`,
 * `author_kind: client` — so the Inbox shows "needs reply", a resolved or
 * waiting_client case reopens, and somebody is actually told. Nothing is
 * emailed back out to the client who just wrote it.
 */
export async function replyToPortalThread(formData: FormData): Promise<ActionResult> {
  const session = await requireClient();
  installWebEnqueue();

  const parsed = ReplySchema.safeParse({
    ticketId: formData.get("ticketId"),
    body: formData.get("body"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const { ticketId, body } = parsed.data;

  try {
    // Scoped by organisation *and* client: a ticket id posted from outside the
    // form resolves to nothing unless it is this client's own ticket.
    const [ticket] = await getDb()
      .select({ conversationId: schema.tickets.conversationId })
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.id, ticketId),
          eq(schema.tickets.organisationId, session.organisationId),
          eq(schema.tickets.clientId, session.clientId),
          // A client cannot write into an internal case they were never
          // shown, even by posting its id straight at this action.
          eq(schema.tickets.clientVisible, true),
        ),
      );
    if (!ticket?.conversationId) return { status: "error", message: "That request could not be found." };

    await replyAsClient(getDb(), session.organisationId, {
      conversationId: ticket.conversationId,
      body,
      actorId: session.userId,
      clientId: session.clientId,
    });
  } catch (error) {
    console.error("portal reply failed", error);
    return { status: "error", message: "That reply could not be sent. Please try again." };
  }

  revalidatePath(`/portal/support/${ticketId}`);
  revalidatePath("/portal/support");
  revalidatePath("/portal");
  return { status: "ok", id: ticketId };
}
