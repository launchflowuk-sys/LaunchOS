import { getMeeting, meetingIcsUrl, meetingManageUrl } from "@launchos/core";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { formatInZone, zoneCity } from "@/lib/booking/slot-days";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { cancelMeetingAction, markOutcomeAction } from "../actions";
import { MeetingStatusBadge } from "../meeting-status-badge";
import { MEETING_KIND_LABEL, MEETING_SOURCE_LABEL, OUTCOME_LABEL } from "../schemas";

export const dynamic = "force-dynamic";

const HOST_ZONE = "Europe/London";

/** True once the call's end time has passed — the moment an outcome is worth asking for. */
function hasEnded(meeting: { endsAt: Date }): boolean {
  return meeting.endsAt.getTime() <= Date.now();
}

/** Who the meeting is filed under — the lead or the client — as a link. */
async function subjectLink(meeting: { leadId: string | null; clientId: string | null; organisationId: string }) {
  const db = getDb();
  if (meeting.clientId) {
    const [client] = await db.select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, meeting.clientId));
    if (client) return { label: "Client", href: `/clients/${meeting.clientId}`, name: client.name };
  }
  if (meeting.leadId) {
    const [lead] = await db.select({ name: schema.leads.name, business: schema.leads.business }).from(schema.leads).where(eq(schema.leads.id, meeting.leadId));
    if (lead) return { label: "Lead", href: `/leads/${meeting.leadId}`, name: lead.business ?? lead.name };
  }
  return null;
}

export default async function MeetingPage({ params }: PageProps<"/meetings/[id]">) {
  const session = await requireAdmin();
  const id = uuidOr404((await params).id);

  const meeting = await getMeeting(getDb(), session.organisationId, id);
  if (!meeting) notFound();
  const subject = await subjectLink(meeting);

  const live = meeting.status === "scheduled" || meeting.status === "rescheduled";
  const ended = hasEnded(meeting);
  const guestZoneDiffers = meeting.guestTimezone !== HOST_ZONE;
  const metadata = meeting.metadata as Record<string, unknown>;
  const source = typeof metadata.source === "string" ? metadata.source : null;

  return (
    <>
      <PageHeader
        title={`${MEETING_KIND_LABEL[meeting.kind]} with ${meeting.guestName}`}
        description={`${formatInZone(meeting.startsAt, HOST_ZONE)} · ${subject ? `${subject.label}: ${subject.name}` : "not filed under anyone"}`}
        category="delivery"
        actions={
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto sm:justify-end">
            <MeetingStatusBadge status={meeting.status} />
            {live ? (
              <Button asChild>
                <a href={meeting.hostUrl ?? meeting.joinUrl} target="_blank" rel="noreferrer">
                  Join as host
                </a>
              </Button>
            ) : null}
            <Button asChild variant="secondary">
              <Link href="/meetings">All meetings</Link>
            </Button>
          </div>
        }
      />

      {live && ended ? (
        <InlineAlert tone="warning" title="This call has ended" className="mb-6">
          Mark how it went below. A no-show sends the guest one &ldquo;sorry we missed you&rdquo; email with a link to rebook.
        </InlineAlert>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <Section title="Details">
            <div className="rounded-xl border bg-card p-4">
              <KeyValue
                columns={2}
                items={[
                  { label: "Guest", value: meeting.guestName },
                  {
                    label: "Email",
                    value: (
                      <a href={`mailto:${meeting.guestEmail}`} className="text-primary underline underline-offset-2">
                        {meeting.guestEmail}
                      </a>
                    ),
                  },
                  { label: "When (London)", value: formatInZone(meeting.startsAt, HOST_ZONE) },
                  {
                    label: "Guest's time",
                    value: guestZoneDiffers ? formatInZone(meeting.startsAt, meeting.guestTimezone) : "Same as ours",
                    ...(guestZoneDiffers ? { hint: zoneCity(meeting.guestTimezone) } : {}),
                  },
                  { label: "Kind", value: MEETING_KIND_LABEL[meeting.kind] },
                  { label: "Booked through", value: source ? (MEETING_SOURCE_LABEL[source] ?? source) : "—" },
                  {
                    label: "Filed under",
                    value: subject ? (
                      <Link href={subject.href} className="text-primary underline underline-offset-2">
                        {subject.name}
                      </Link>
                    ) : (
                      "—"
                    ),
                  },
                  { label: "Provider", value: meeting.provider === "zoom" ? "Zoom" : "Mock (no Zoom keys set)" },
                  {
                    label: "Join link",
                    value: (
                      <a href={meeting.joinUrl} target="_blank" rel="noreferrer" className="break-all text-primary underline underline-offset-2">
                        {meeting.joinUrl}
                      </a>
                    ),
                    hint: "The guest's link, from their confirmation email.",
                  },
                  {
                    label: "Guest's page",
                    value: (
                      <a href={meetingManageUrl(meeting)} target="_blank" rel="noreferrer" className="break-all text-primary underline underline-offset-2">
                        Move or cancel
                      </a>
                    ),
                    hint: "The same link the guest has. The calendar file is beside it.",
                  },
                  { label: "Booked", value: formatDateTime(meeting.createdAt) },
                  { label: "Last changed", value: formatDateTime(meeting.updatedAt) },
                ]}
              />
            </div>
          </Section>

          {meeting.notes ? (
            <Section title="Notes" description={live ? "What the guest wrote when booking." : "From the booking and the outcome."}>
              <div className="rounded-xl border bg-card p-4">
                <p className="text-sm break-words whitespace-pre-wrap">{meeting.notes}</p>
              </div>
            </Section>
          ) : null}
        </div>

        <div className="min-w-0">
          {live ? (
            <>
              <Section title="Outcome" description="Once the call has happened. Notes are kept on the meeting.">
                <ActionForm action={markOutcomeAction} ariaLabel="Mark outcome" success="Outcome recorded" className="grid gap-3 rounded-xl border bg-card p-4">
                  <input type="hidden" name="meetingId" value={meeting.id} />
                  <div className="space-y-1.5">
                    <Label htmlFor="meeting-outcome">How did it go?</Label>
                    <NativeSelect id="meeting-outcome" name="outcome" defaultValue="completed">
                      {Object.entries(OUTCOME_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="meeting-notes">Notes</Label>
                    <Textarea id="meeting-notes" name="notes" rows={4} maxLength={4000} placeholder="What they need, what was agreed, next step." />
                  </div>
                  <Button type="submit" className="max-sm:w-full sm:justify-self-end">
                    Save outcome
                  </Button>
                </ActionForm>
              </Section>

              <Section title="Cancel" description="The guest is emailed the reason and a link to book again.">
                <ActionForm action={cancelMeetingAction} ariaLabel="Cancel meeting" success="Meeting cancelled" className="grid gap-3 rounded-xl border bg-card p-4">
                  <input type="hidden" name="meetingId" value={meeting.id} />
                  <div className="space-y-1.5">
                    <Label htmlFor="cancel-reason">Reason (optional)</Label>
                    <Textarea id="cancel-reason" name="reason" rows={2} maxLength={500} />
                  </div>
                  <Button type="submit" variant="destructive-quiet" className="max-sm:w-full sm:justify-self-end">
                    Cancel this meeting
                  </Button>
                </ActionForm>
              </Section>
            </>
          ) : (
            <Section title="Outcome">
              <div className="rounded-xl border bg-card p-4">
                <KeyValue
                  items={[
                    { label: "Status", value: <MeetingStatusBadge status={meeting.status} /> },
                    ...(typeof metadata.cancelReason === "string" ? [{ label: "Reason", value: metadata.cancelReason }] : []),
                  ]}
                />
                <p className="mt-4 text-meta text-muted-foreground">Nothing more to do here.</p>
              </div>
            </Section>
          )}

          <p className="mt-6 text-meta text-muted-foreground">
            Calendar file:{" "}
            <a href={meetingIcsUrl(meeting)} className="underline hover:text-foreground">
              calendar.ics
            </a>
          </p>
        </div>
      </div>
    </>
  );
}
