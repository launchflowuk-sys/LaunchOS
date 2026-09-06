"use server";

import { cancelMeeting, markMeetingOutcome, MeetingRefused } from "@launchos/core";
import { createMeetingsAdapterFromEnv } from "@launchos/integrations";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";
import { type ActionResult, CancelMeetingFormSchema, firstIssue, MarkOutcomeSchema } from "./schemas";

function value(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : undefined;
}

/** A core refusal ("that meeting is not live") is a sentence for the toast, never a 500. */
function failed(error: unknown, fallback: string): ActionResult {
  if (error instanceof MeetingRefused) return { status: "error", message: error.message };
  console.error(fallback, error);
  return { status: "error", message: error instanceof Error ? error.message : fallback };
}

function revalidateMeeting(meetingId: string, leadId: string | null, clientId: string | null): void {
  revalidatePath("/meetings");
  revalidatePath(`/meetings/${meetingId}`);
  revalidatePath("/");
  if (leadId) revalidatePath(`/leads/${leadId}`);
  if (clientId) revalidatePath(`/clients/${clientId}`);
}

/**
 * "Mark completed" / "Mark no-show" with notes. Gated like Leads: any
 * signed-in member — a meeting is new business, not billing or support. A
 * no-show queues the one courtesy "sorry we missed you" email (core stamps it
 * so the cron cannot send a second), which is why the enqueue is installed.
 */
export async function markOutcomeAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = MarkOutcomeSchema.safeParse({
    meetingId: value(formData, "meetingId"),
    outcome: value(formData, "outcome"),
    notes: value(formData, "notes") ?? "",
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Choose an outcome") };

  installWebEnqueue();
  try {
    const { meeting } = await markMeetingOutcome(getDb(), session.organisationId, {
      meetingId: parsed.data.meetingId,
      outcome: parsed.data.outcome,
      ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
      actorId: session.userId,
    });
    revalidateMeeting(meeting.id, meeting.leadId, meeting.clientId);
    return { status: "ok", id: meeting.id };
  } catch (error) {
    return failed(error, "Could not record the outcome");
  }
}

/** Cancel from the admin side: the guest is emailed with the reason and a rebook link. */
export async function cancelMeetingAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = CancelMeetingFormSchema.safeParse({ meetingId: value(formData, "meetingId"), reason: value(formData, "reason") ?? "" });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the reason and try again") };

  installWebEnqueue();
  try {
    const { meeting } = await cancelMeeting(
      getDb(),
      session.organisationId,
      { meetingId: parsed.data.meetingId, ...(parsed.data.reason ? { reason: parsed.data.reason } : {}), actorKind: "user", actorId: session.userId },
      { meetings: createMeetingsAdapterFromEnv(process.env) },
    );
    revalidateMeeting(meeting.id, meeting.leadId, meeting.clientId);
    return { status: "ok", id: meeting.id };
  } catch (error) {
    return failed(error, "Could not cancel the meeting");
  }
}
