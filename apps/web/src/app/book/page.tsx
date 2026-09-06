import { availableSlots } from "@launchos/core";
import type { Metadata } from "next";
import { InlineAlert } from "@/components/inline-alert";
import { getDb } from "@/lib/db";
import { PublicShell } from "../(marketing)/site/_components/public-shell";
import { BookingForm } from "./booking-form";
import { bookingHostLabel, resolveBookingContext } from "./context";

// Public and unauthenticated by position, like `/signup`: this route sits
// outside the `(admin)` and `(portal)` groups, so neither shell's `require*`
// runs here. It answers on both hosts — `launchflow.co.uk/book` is passed
// through by the proxy — because the acknowledgement email links to it.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Book a call — LaunchFlow",
  description: "Pick a time for a 30-minute video call with LaunchFlow.",
  robots: { index: false, follow: false },
};

export default async function BookPage({ searchParams }: PageProps<"/book">) {
  const params = await searchParams;
  const leadToken = typeof params.lead === "string" && params.lead.trim().length > 0 ? params.lead.trim() : null;

  const context = await resolveBookingContext(leadToken);
  if (!context) {
    return (
      <PublicShell narrow title="Book a call" description="A short video call to talk through what you need.">
        <InlineAlert tone="info" title="Booking is not open just yet">
          Reply to our email and we will find a time by hand.
        </InlineAlert>
      </PublicShell>
    );
  }

  const [slots, host] = await Promise.all([
    // Read in the host's zone; the picker re-labels every slot in the
    // visitor's own zone once the browser says which that is.
    availableSlots(getDb(), context.organisationId, {}),
    bookingHostLabel(context.organisationId),
  ]);

  const greeting = context.name ? `Hello ${context.name.split(/\s+/)[0]}, pick a time that suits you.` : "Pick a time that suits you.";

  return (
    <PublicShell
      title="Book a call"
      description={`${greeting} A ${slots.slotMinutes}-minute video call on Zoom to talk through what you need — no cost, no obligation.`}
    >
      <BookingForm
        picker={{
          slots: slots.slots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt, hostTime: s.hostTime, hostDate: s.hostDate })),
          from: slots.from,
          to: slots.to,
          slotMinutes: slots.slotMinutes,
          host: { timezone: host.timezone, firstName: host.firstName },
        }}
        defaults={{ name: context.name, email: context.email }}
        leadToken={context.leadToken}
      />
    </PublicShell>
  );
}
