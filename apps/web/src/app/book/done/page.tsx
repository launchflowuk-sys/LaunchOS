import { getMeetingByToken, meetingIcsUrl, meetingManageUrl, resolveBookingHost } from "@launchos/core";
import type { Metadata } from "next";
import { CalendarPlus, Video } from "lucide-react";
import Link from "next/link";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { Button } from "@/components/ui/button";
import { formatInZone, zoneCity } from "@/lib/booking/slot-days";
import { getDb } from "@/lib/db";
import { PublicShell } from "../../(marketing)/site/_components/public-shell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your call is booked — LaunchFlow",
  robots: { index: false, follow: false },
};

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
      <PublicShell narrow title="Booking" description="Nothing to show.">
        <InlineAlert tone="info" title="We could not find that booking">
          Use the link in your confirmation email, or book again.
        </InlineAlert>
        <div className="mt-5 flex justify-center">
          <Button asChild size="lg" variant="secondary" className="btn btn-white">
            <Link href="/book">Book a call</Link>
          </Button>
        </div>
      </PublicShell>
    );
  }

  const { settings } = await resolveBookingHost(getDb(), meeting.organisationId);
  const guestTime = formatInZone(meeting.startsAt, meeting.guestTimezone);
  const hostTime = meeting.guestTimezone === settings.timezone ? null : formatInZone(meeting.startsAt, settings.timezone, "short");
  const live = meeting.status === "scheduled" || meeting.status === "rescheduled";

  return (
    <PublicShell narrow title={moved ? "Your call has moved" : "You're booked"} description="We have emailed the details too.">
      <InlineAlert tone={live ? "success" : "warning"} title={live ? (moved ? "New time confirmed" : "Call confirmed") : "This call is no longer live"}>
        {live ? `We will see you on ${guestTime}.` : "It was cancelled or has already happened. Book again if you would like another."}
      </InlineAlert>

      <div className="card mt-5 p-6 text-left">
        <KeyValue
          items={[
            { label: "When", value: guestTime, ...(hostTime ? { hint: `${hostTime} in ${zoneCity(settings.timezone)}` } : {}) },
            { label: "With", value: "LaunchFlow, on Zoom" },
            { label: "Sent to", value: meeting.guestEmail },
          ]}
        />
        {live ? (
          <div className="mt-5 flex flex-col gap-2">
            <Button asChild size="lg" className="btn btn-ink">
              <a href={meeting.joinUrl} target="_blank" rel="noreferrer">
                <Video aria-hidden className="size-4" />
                Join the call
              </a>
            </Button>
            <Button asChild size="lg" variant="secondary" className="btn btn-white">
              {/* A real navigation, not a fetch: the route answers `text/calendar` and the browser hands it to the calendar app. */}
              <a href={new URL(meetingIcsUrl(meeting)).pathname}>
                <CalendarPlus aria-hidden className="size-4" />
                Add to calendar
              </a>
            </Button>
          </div>
        ) : null}
      </div>

      <p className="mt-6 text-center text-sm text-[var(--mute)]">
        Need a different time?{" "}
        <Link href={new URL(meetingManageUrl(meeting)).pathname} className="link-blue">
          Move or cancel the call
        </Link>
        .
      </p>
    </PublicShell>
  );
}
