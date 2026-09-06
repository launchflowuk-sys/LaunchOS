import { availableSlots, getMeetingByToken, meetingIcsUrl, rebookUrl, resolveBookingHost } from "@launchos/core";
import { CalendarPlus, Video } from "lucide-react";
import Link from "next/link";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { Button } from "@/components/ui/button";
import { formatInZone, zoneCity } from "@/lib/booking/slot-days";
import { getDb } from "@/lib/db";
import { SignupShell } from "../../../signup/signup-shell";
import { bookingHostLabel } from "../../context";
import { CancelForm, RescheduleForm } from "./manage-form";

export const dynamic = "force-dynamic";

/**
 * The guest's own page for a booking: move it or cancel it. The token in
 * the address is the one from their confirmation email and is the whole of
 * the authority — there is no sign-in, and nothing else identifies the
 * meeting. A cancelled or finished call reads as such, with a link to book
 * again.
 */
export default async function ManageBookingPage({ params, searchParams }: PageProps<"/book/r/[token]">) {
  const { token } = await params;
  const query = await searchParams;
  const justCancelled = query.cancelled === "1";
  const db = getDb();

  const meeting = await getMeetingByToken(db, token);
  if (!meeting) {
    return (
      <SignupShell narrow title="Your call" description="Nothing to show.">
        <InlineAlert tone="info" title="We could not find that booking">
          Use the link in your confirmation email, or book again.
        </InlineAlert>
        <div className="mt-5 flex justify-center">
          <Button asChild size="lg" variant="secondary">
            <Link href="/book">Book a call</Link>
          </Button>
        </div>
      </SignupShell>
    );
  }

  const live = meeting.status === "scheduled" || meeting.status === "rescheduled";
  const [{ settings }, host, slots, rebook] = await Promise.all([
    resolveBookingHost(db, meeting.organisationId),
    bookingHostLabel(meeting.organisationId),
    live ? availableSlots(db, meeting.organisationId, { excludeMeetingId: meeting.id, guestTimezone: meeting.guestTimezone }) : null,
    rebookUrl(db, meeting),
  ]);
  const guestTime = formatInZone(meeting.startsAt, meeting.guestTimezone);
  const hostTime = meeting.guestTimezone === settings.timezone ? null : formatInZone(meeting.startsAt, settings.timezone, "short");
  const rebookPath = new URL(rebook).pathname + new URL(rebook).search;

  if (!live) {
    const words =
      meeting.status === "cancelled"
        ? justCancelled
          ? "Your call is cancelled and the slot is free again. We have emailed you to say so."
          : "This call was cancelled."
        : "This call has already happened.";
    return (
      <SignupShell narrow title="Your call" description={guestTime}>
        <InlineAlert tone={justCancelled ? "success" : "info"} title={meeting.status === "cancelled" ? "Cancelled" : "Finished"}>
          {words}
        </InlineAlert>
        <div className="mt-5 flex justify-center">
          <Button asChild size="lg">
            <Link href={rebookPath}>Book another time</Link>
          </Button>
        </div>
      </SignupShell>
    );
  }

  return (
    <SignupShell title="Your call with LaunchFlow" description="Move it to another time, or cancel it, from here.">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="space-y-6">
          <RescheduleForm
            token={meeting.rescheduleToken}
            picker={{
              slots: (slots?.slots ?? []).map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt, hostTime: s.hostTime, hostDate: s.hostDate })),
              from: slots?.from ?? new Date().toISOString(),
              to: slots?.to ?? new Date().toISOString(),
              slotMinutes: slots?.slotMinutes ?? settings.slotMinutes,
              host: { timezone: host.timezone, firstName: host.firstName },
              initialTimeZone: meeting.guestTimezone,
            }}
          />
          <CancelForm token={meeting.rescheduleToken} />
        </div>

        <div className="rounded-xl border bg-card p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold">Booked for</h2>
          <div className="mt-4">
            <KeyValue
              items={[
                { label: "When", value: guestTime, ...(hostTime ? { hint: `${hostTime} in ${zoneCity(settings.timezone)}` } : {}) },
                { label: "Name", value: meeting.guestName },
                { label: "Email", value: meeting.guestEmail },
              ]}
            />
          </div>
          <div className="mt-5 flex flex-col gap-2">
            <Button asChild>
              <a href={meeting.joinUrl} target="_blank" rel="noreferrer">
                <Video aria-hidden className="size-4" />
                Join the call
              </a>
            </Button>
            <Button asChild variant="secondary">
              <a href={new URL(meetingIcsUrl(meeting)).pathname}>
                <CalendarPlus aria-hidden className="size-4" />
                Add to calendar
              </a>
            </Button>
          </div>
        </div>
      </div>
    </SignupShell>
  );
}
