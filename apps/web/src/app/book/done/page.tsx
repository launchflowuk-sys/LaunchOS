import { getMeetingByToken, meetingIcsUrl, meetingManageUrl, resolveBookingHost } from "@launchos/core";
import { CalendarPlus, Video } from "lucide-react";
import Link from "next/link";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { Button } from "@/components/ui/button";
import { formatInZone, zoneCity } from "@/lib/booking/slot-days";
import { getDb } from "@/lib/db";
import { SignupShell } from "../../signup/signup-shell";

export const dynamic = "force-dynamic";

/**
 * "You're booked." Keyed by the meeting's own reschedule token — the one
 * thing the guest was emailed and nobody can guess — so the page shows the
 * join link, the calendar file and the change/cancel link without an id in
 * the address bar. A wrong token earns nothing.
 */
export default async function BookDonePage({ searchParams }: PageProps<"/book/done">) {
  const params = await searchParams;
  const token = typeof params.m === "string" ? params.m.trim() : "";
  const moved = params.moved === "1";

  const meeting = token ? await getMeetingByToken(getDb(), token) : null;
  if (!meeting) {
    return (
      <SignupShell narrow title="Booking" description="Nothing to show.">
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

  const { settings } = await resolveBookingHost(getDb(), meeting.organisationId);
  const guestTime = formatInZone(meeting.startsAt, meeting.guestTimezone);
  const hostTime = meeting.guestTimezone === settings.timezone ? null : formatInZone(meeting.startsAt, settings.timezone, "short");
  const live = meeting.status === "scheduled" || meeting.status === "rescheduled";

  return (
    <SignupShell narrow title={moved ? "Your call has moved" : "You're booked"} description="We have emailed the details too.">
      <InlineAlert tone={live ? "success" : "warning"} title={live ? (moved ? "New time confirmed" : "Call confirmed") : "This call is no longer live"}>
        {live ? `We will see you on ${guestTime}.` : "It was cancelled or has already happened. Book again if you would like another."}
      </InlineAlert>

      <div className="mt-5 rounded-xl border bg-card p-5 shadow-sm">
        <KeyValue
          items={[
            { label: "When", value: guestTime, ...(hostTime ? { hint: `${hostTime} in ${zoneCity(settings.timezone)}` } : {}) },
            { label: "With", value: "LaunchFlow, on Zoom" },
            { label: "Sent to", value: meeting.guestEmail },
          ]}
        />
        {live ? (
          <div className="mt-5 flex flex-col gap-2">
            <Button asChild size="lg">
              <a href={meeting.joinUrl} target="_blank" rel="noreferrer">
                <Video aria-hidden className="size-4" />
                Join the call
              </a>
            </Button>
            <Button asChild size="lg" variant="secondary">
              {/* A real navigation, not a fetch: the route answers `text/calendar` and the browser hands it to the calendar app. */}
              <a href={new URL(meetingIcsUrl(meeting)).pathname}>
                <CalendarPlus aria-hidden className="size-4" />
                Add to calendar
              </a>
            </Button>
          </div>
        ) : null}
      </div>

      <p className="mt-5 text-center text-sm text-muted-foreground">
        Need a different time?{" "}
        <Link href={new URL(meetingManageUrl(meeting)).pathname} className="font-medium text-primary underline underline-offset-2">
          Move or cancel the call
        </Link>
        .
      </p>
    </SignupShell>
  );
}
