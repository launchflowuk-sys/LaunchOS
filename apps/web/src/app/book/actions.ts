"use server";

import { bookMeeting, cancelMeeting, getMeetingByToken, MeetingRefused, rescheduleMeeting } from "@launchos/core";
import { createMeetingsAdapterFromEnv } from "@launchos/integrations";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";
import { clientAddress } from "@/lib/rate-limit";
import { resolveBookingContext } from "./context";
import { type BookingActionResult, bookingLimiter, BookSchema, CancelSchema, firstIssue, RescheduleSchema } from "./schemas";

/** The address behind the request, for the per-address limit. A server action only has headers. */
async function requestAddress(): Promise<string> {
  return clientAddress(new Request("http://localhost/", { headers: await headers() }));
}

/** Core's refusals are written for the page; anything else is ours to log. */
function refused(error: unknown, fallback: string): BookingActionResult {
  if (error instanceof MeetingRefused) {
    // A slot that went while the visitor was typing: say so and re-read the diary.
    return { status: "error", message: error.message, refresh: error.reason === "slot_taken" || error.reason === "past" };
  }
  console.error("[book] booking action failed", { error });
  return { status: "error", message: fallback };
}

/**
 * "Confirm" on `/book`. Public — there is no session to check unless a
 * portal user is signed in — so it re-resolves who is booking from the lead
 * token and the cookie rather than from anything the form says about ids,
 * validates every field, limits bookings per address, and books through
 * core, which creates the Zoom (or mock) meeting synchronously so the join
 * link is on the done page at once. Success is a redirect to `/book/done`
 * keyed by the meeting's own unguessable token.
 */
export async function bookAction(_previous: BookingActionResult | null, formData: FormData): Promise<BookingActionResult> {
  const parsed = BookSchema.safeParse({
    startsAt: formData.get("startsAt"),
    guestTimezone: formData.get("guestTimezone") ?? "",
    name: formData.get("name"),
    email: formData.get("email"),
    notes: formData.get("notes") ?? "",
    lead: formData.get("lead") ?? "",
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const v = parsed.data;

  const address = await requestAddress();
  if (!bookingLimiter.allow(address)) {
    return { status: "error", message: "Too many bookings from this connection for now. Try again in an hour, or reply to our email." };
  }

  const context = await resolveBookingContext(v.lead ?? null);
  if (!context) return { status: "error", message: "Booking is not open at the moment. Reply to our email and we will find a time." };

  // The confirmation email and the host's bell go out through the queue.
  installWebEnqueue();
  let token: string;
  try {
    const { meeting } = await bookMeeting(
      getDb(),
      context.organisationId,
      {
        kind: "discovery",
        ...(context.leadId ? { leadId: context.leadId } : {}),
        ...(context.clientId && !context.leadId ? { clientId: context.clientId } : {}),
        guestName: v.name,
        guestEmail: v.email,
        guestTimezone: v.guestTimezone,
        startsAt: v.startsAt,
        ...(v.notes ? { notes: v.notes } : {}),
        source: context.source,
        actorKind: "client",
        ...(context.actorId ? { actorId: context.actorId } : {}),
      },
      { meetings: createMeetingsAdapterFromEnv(process.env) },
    );
    token = meeting.rescheduleToken;
  } catch (error) {
    return refused(error, "Something went wrong booking the call. Please try again, or reply to our email.");
  }
  revalidatePath("/meetings");
  revalidatePath("/");
  redirect(`/book/done?m=${encodeURIComponent(token)}`);
}

/**
 * "Move to this time" on `/book/r/<token>`. The token is the whole of the
 * authority — it was emailed to the guest and is unguessable — and the
 * meeting's organisation comes from the row, never from the form.
 */
export async function rescheduleAction(_previous: BookingActionResult | null, formData: FormData): Promise<BookingActionResult> {
  const parsed = RescheduleSchema.safeParse({
    token: formData.get("token"),
    startsAt: formData.get("startsAt"),
    guestTimezone: formData.get("guestTimezone") ?? "",
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Pick a new time") };
  const v = parsed.data;

  const address = await requestAddress();
  if (!bookingLimiter.allow(address)) return { status: "error", message: "Too many changes from this connection for now. Try again in an hour." };

  const meeting = await getMeetingByToken(getDb(), v.token);
  if (!meeting) return { status: "error", message: "That booking link is not one we recognise." };

  installWebEnqueue();
  try {
    await rescheduleMeeting(
      getDb(),
      meeting.organisationId,
      { meetingId: meeting.id, startsAt: v.startsAt, guestTimezone: v.guestTimezone, actorKind: "client" },
      { meetings: createMeetingsAdapterFromEnv(process.env) },
    );
  } catch (error) {
    return refused(error, "Something went wrong moving the call. Please try again, or reply to our email.");
  }
  revalidatePath("/meetings");
  revalidatePath(`/book/r/${encodeURIComponent(v.token)}`);
  redirect(`/book/done?m=${encodeURIComponent(v.token)}&moved=1`);
}

/** "Cancel this call" on `/book/r/<token>`. The page re-renders as cancelled with a rebook link. */
export async function cancelAction(_previous: BookingActionResult | null, formData: FormData): Promise<BookingActionResult> {
  const parsed = CancelSchema.safeParse({ token: formData.get("token"), reason: formData.get("reason") ?? "" });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const v = parsed.data;

  const meeting = await getMeetingByToken(getDb(), v.token);
  if (!meeting) return { status: "error", message: "That booking link is not one we recognise." };

  installWebEnqueue();
  try {
    await cancelMeeting(
      getDb(),
      meeting.organisationId,
      { meetingId: meeting.id, ...(v.reason ? { reason: v.reason } : {}), actorKind: "client" },
      { meetings: createMeetingsAdapterFromEnv(process.env) },
    );
  } catch (error) {
    return refused(error, "Something went wrong cancelling the call. Please try again, or reply to our email.");
  }
  revalidatePath("/meetings");
  revalidatePath(`/book/r/${encodeURIComponent(v.token)}`);
  redirect(`/book/r/${encodeURIComponent(v.token)}?cancelled=1`);
}
