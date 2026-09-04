"use server";

import { assignTicket, escalateTicket, replyToConversation, updateTicket } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { installWebEnqueue, sendJob } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";

/** Each admin module declares its own `ActionResult` with this shape. */
export type ActionResult = { status: "ok" } | { status: "error"; message: string };

const TicketId = z.string().uuid();
const StatusInput = z.object({ ticketId: TicketId, status: z.enum(schema.ticketStatusEnum.enumValues) });
const AssignInput = z.object({ ticketId: TicketId, assignedUserId: z.string().min(1).optional() });
const EscalateInput = z.object({ ticketId: TicketId, reason: z.string().trim().min(1).max(1000) });
const NoteInput = z.object({
  ticketId: TicketId,
  conversationId: z.string().uuid(),
  body: z.string().trim().min(1).max(8000),
});

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
 */
export async function addCaseNote(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = NoteInput.safeParse({
    ticketId: formData.get("ticketId"),
    conversationId: formData.get("conversationId"),
    body: formData.get("body"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await replyToConversation(getDb(), session.organisationId, {
      conversationId: parsed.data.conversationId,
      body: parsed.data.body,
      actorKind: "user",
      actorId: session.userId,
      internal: true,
    });
    revalidateCase(parsed.data.ticketId);
    revalidatePath(`/inbox/${parsed.data.conversationId}`);
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
