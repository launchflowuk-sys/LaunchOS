import { listMeetings } from "@launchos/core";
import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { Section } from "@/components/section";
import { formatInZone } from "@/lib/booking/slot-days";
import { getDb } from "@/lib/db";
import { MeetingStatusBadge } from "./meeting-status-badge";
import { MEETING_KIND_LABEL } from "./schemas";

const HOST_ZONE = "Europe/London";
const STRIP_LIMIT = 8;

/**
 * The calls filed under a lead or a client, newest first, as a short strip
 * on their page: when, what kind, how it went, and a link to the meeting.
 * A server component — it reads for the organisation the caller passes and
 * never for anyone else's.
 */
export async function MeetingsStrip({
  organisationId,
  leadId,
  clientId,
  bookHref,
}: {
  organisationId: string;
  leadId?: string | undefined;
  clientId?: string | undefined;
  /** A booking link to offer when there is nothing yet — the lead's own token link, or `/book`. */
  bookHref?: string | undefined;
}) {
  const meetings = await listMeetings(getDb(), organisationId, {
    scope: "all",
    ...(leadId ? { leadId } : {}),
    ...(clientId ? { clientId } : {}),
    limit: STRIP_LIMIT,
  });
  const sorted = [...meetings].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());

  return (
    <Section title="Meetings" description="Calls booked through the booking page.">
      {sorted.length === 0 ? (
        <EmptyState icon={CalendarClock}>
          No calls booked yet.
          {bookHref ? (
            <>
              {" "}
              <a href={bookHref} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
                Their booking link
              </a>{" "}
              is in every email we send them.
            </>
          ) : null}
        </EmptyState>
      ) : (
        <ul className="grid gap-2" aria-label="Meetings">
          {sorted.map((meeting) => (
            <li key={meeting.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card px-4 py-3 text-sm">
              <Link href={`/meetings/${meeting.id}`} className="font-medium hover:underline">
                {formatInZone(meeting.startsAt, HOST_ZONE, "short")}
              </Link>
              <span className="text-muted-foreground">{MEETING_KIND_LABEL[meeting.kind]}</span>
              <span className="ml-auto">
                <MeetingStatusBadge status={meeting.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
