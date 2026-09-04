"use server";

import { assignTicket, escalateTicket, replyToConversation, updateTicket } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { installWebEnqueue, sendJob } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";
import {
  type ActionResult,
  AssignInput,
  EscalateInput,
  NoteInput,
  StatusInput,
  TicketId,
} from "./schemas";
import { hasTriageInFlight } from "./triage-status";

function failed(error: unknown): ActionResult {
  return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
}

function invalid(error: z.ZodError): ActionResult {
  return { status: "error", message: error.issues[0]?.message ?? "Invalid input" };
}

function revalidateCase(ticketId: string): void {
  revalidatePath(`/cases/${ticketId}`);
  revalidatePath("/cases");
}

export async function setTicketStatus(formData: FormData): Promise<ActionResult> {
  // Server Actions accept direct POSTs, so every action re-authorises and re-validates.
  const session = await requireAdmin();
  const parsed = StatusInput.safeParse({
    ticketId: formData.get("ticketId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await updateTicket(getDb(), session.organisationId, {
      ticketId: parsed.data.ticketId,
      status: parsed.data.status,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateCase(parsed.data.ticketId);
    return { status: "ok" };
  } catch (error) {
    return failed(error);
  }
}

export async function assignTicketAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const raw = formData.get("assignedUserId");
  // An empty select means "let core pick the least-loaded staff member".
  const assignedUserId = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  const parsed = AssignInput.safeParse({
    ticketId: formData.get("ticketId"),
    ...(assignedUserId ? { assignedUserId } : {}),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await assignTicket(getDb(), session.organisationId, {
      ticketId: parsed.data.ticketId,
      ...(parsed.data.assignedUserId ? { assignedUserId: parsed.data.assignedUserId } : {}),
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateCase(parsed.data.ticketId);
    return { status: "ok" };
  } catch (error) {
    return failed(error);
  }
}

export async function escalateTicketAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = EscalateInput.safeParse({
    ticketId: formData.get("ticketId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) return invalid(parsed.error);

  // escalateTicket emits `ticket.escalated`; without this the event is dropped.
  installWebEnqueue();

  try {
    await escalateTicket(getDb(), session.organisationId, {
      ticketId: parsed.data.ticketId,
      reason: parsed.data.reason,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateCase(parsed.data.ticketId);
    return { status: "ok" };
  } catch (error) {
    return failed(error);
  }
}

/**
 * An internal note on the case thread. A human writing here is never an
 * outbound email — `replyToConversation` writes it `internal` and emits
 * nothing, so nothing leaves LaunchOS.
 *
 * The thread is read off the ticket rather than taken from the form: the
 * ticket id is the thing the operator actually chose, and two ids that can
 * disagree would let a stale form drop a note into another client's
 * conversation with nothing in the case history to show for it.
 */
export async function addCaseNote(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = NoteInput.safeParse({
    ticketId: formData.get("ticketId"),
    body: formData.get("body"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    const [ticket] = await getDb()
      .select({ conversationId: schema.tickets.conversationId })
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.id, parsed.data.ticketId),
          eq(schema.tickets.organisationId, session.organisationId),
        ),
      );
    if (!ticket) return { status: "error", message: "Case not found" };
    if (!ticket.conversationId) return { status: "error", message: "This case has no conversation" };

    await replyToConversation(getDb(), session.organisationId, {
      conversationId: ticket.conversationId,
      body: parsed.data.body,
      actorKind: "user",
      actorId: session.userId,
      internal: true,
    });
    revalidateCase(parsed.data.ticketId);
    revalidatePath(`/inbox/${ticket.conversationId}`);
    return { status: "ok" };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Re-runs Support Triage on demand. The job is addressed to the same
 * `agent.run` queue `ticket.created` would have used, and the worker still
 * honours `agent_enablement` — a disabled agent stays disabled.
 */
export async function runTriageNow(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = TicketId.safeParse(formData.get("ticketId"));
  if (!parsed.success) return invalid(parsed.error);
  const ticketId = parsed.data;

  try {
    // The payload is built here, scoped to the organisation, so a ticket id
    // from another tenant cannot start a run against our data.
    const [ticket] = await getDb()
      .select({
        ticketId: schema.tickets.id,
        clientId: schema.tickets.clientId,
        siteId: schema.tickets.siteId,
        conversationId: schema.tickets.conversationId,
        subject: schema.tickets.subject,
        source: schema.tickets.source,
      })
      .from(schema.tickets)
      .where(and(eq(schema.tickets.id, ticketId), eq(schema.tickets.organisationId, session.organisationId)));
    if (!ticket) return { status: "error", message: "Case not found" };

    // Every press is a real, billed Claude run, and a run still in flight may
    // yet park an approval for this case. Refuse a second one rather than pay
    // for it twice and queue two drafts of the same reply.
    if (await hasTriageInFlight(session.organisationId, ticketId)) {
      return { status: "error", message: "Triage is already running for this case." };
    }

    await sendJob(
      "agent.run",
      {
        agentKey: "support-triage",
        organisationId: session.organisationId,
        trigger: "manual",
        payload: ticket,
      },
      // The timestamp is deliberate: the event-driven run uses
      // `support-triage:<ticketId>`, and a manual re-run must not be swallowed
      // as a duplicate of it, nor of an earlier manual run.
      { singletonKey: `support-triage:${ticketId}:manual:${Date.now()}` },
    );
    revalidateCase(ticketId);
    return { status: "ok" };
  } catch (error) {
    return failed(error);
  }
}
