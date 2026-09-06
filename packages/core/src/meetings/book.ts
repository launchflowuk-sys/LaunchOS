import { randomBytes } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { renderBrandedEmail, type EmailAdapter } from "@launchos/channels";
import type { MeetingsAdapter } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { brandEmailContext } from "../config.js";
import { emit } from "../events/emit.js";
import { createLead, markLeadContacted } from "../leads/leads.js";
import { notify } from "../notifications/notify.js";
import { assertOwned } from "../tenancy/assert-owned.js";
import { buildIcs } from "./ics.js";
import { confirmationBody, meetingIcsUrl, meetingManageUrl, queueMeetingNotice, type MeetingRow } from "./notices.js";
import { resolveBookingHost } from "./settings.js";
import { isSlotAvailable } from "./slots.js";
import { formatInZone, isValidTimeZone } from "./time.js";

/** The host's bell and phone: a call just landed in the diary. Urgent. */
export const MEETING_BOOKED_NOTIFICATION_KIND = "meeting.booked";

export class MeetingRefused extends Error {
  constructor(
    readonly reason: "slot_taken" | "outside_hours" | "provider_failed" | "not_found" | "not_live" | "past",
    message: string,
  ) {
    super(message);
    this.name = "MeetingRefused";
  }
}

export interface MeetingDeps {
  meetings: MeetingsAdapter;
  /** When given, the host also gets an internal email with the join link and the calendar file. */
  email?: EmailAdapter | undefined;
}

export const BookMeetingInput = z.object({
  kind: z.enum(schema.meetingKindEnum.enumValues).default("discovery"),
  leadId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  guestName: z.string().trim().min(1).max(120),
  guestEmail: z.string().trim().email().max(320),
  guestTimezone: z.string().refine(isValidTimeZone, "not an IANA timezone").default("Europe/London"),
  /** A slot start from `availableSlots`, as an instant. */
  startsAt: z.date(),
  notes: z.string().trim().max(2000).optional(),
  /** Where the booking came from: `public`, `portal`, `admin`, `email_link`. Free text, stored on the meeting. */
  source: z.string().trim().max(40).default("public"),
  actorKind: z.enum(["user", "client", "agent", "system"]).default("client"),
  actorId: z.string().optional(),
  now: z.date().optional(),
});
export type BookMeetingInput = z.input<typeof BookMeetingInput>;

export interface BookMeetingResult {
  meeting: MeetingRow;
  /** The lead the meeting is filed under — the one given, or the one minted for a stranger. Null for a client booking. */
  leadId: string | null;
  clientId: string | null;
  /** The queued confirmation to the guest. */
  confirmation: typeof schema.messages.$inferSelect;
  manageUrl: string;
  icsUrl: string;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) => (typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined);
  return code(error) === "23505" || code((error as { cause?: unknown })?.cause) === "23505";
}

export function mintRescheduleToken(): string {
  return randomBytes(24).toString("base64url");
}

async function hostDetails(db: Db, hostUserId: string): Promise<{ name: string; email: string }> {
  const [host] = await db.select({ name: schema.user.name, email: schema.user.email }).from(schema.user).where(eq(schema.user.id, hostUserId));
  if (!host) throw new Error(`host user ${hostUserId} not found`);
  return host;
}

/** Best effort: the host's own email with the join link. A failure is logged; the bell already rang. */
async function emailHost(deps: MeetingDeps, db: Db, meeting: MeetingRow, hostTimezone: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!deps.email) return;
  try {
    const host = await hostDetails(db, meeting.hostUserId);
    const brand = brandEmailContext(env);
    const heading = `Call booked: ${meeting.guestName}`;
    const { text, html } = renderBrandedEmail({
      variant: "internal",
      preheader: `${formatInZone(meeting.startsAt, hostTimezone, "short")} with ${meeting.guestName}`,
      heading,
      paragraphs: [
        `${meeting.guestName} (${meeting.guestEmail}) booked a ${meeting.kind} call for ${formatInZone(meeting.startsAt, hostTimezone)}.`,
        ...(meeting.notes ? [`They said: ${meeting.notes}`] : []),
        `Start the call (host link): ${meeting.hostUrl ?? meeting.joinUrl}`,
        `Calendar file: ${meetingIcsUrl(meeting, env)}`,
      ],
      cta: { label: "Open in LaunchOS", url: `${brand.appUrl}/meetings/${meeting.id}` },
      logoUrl: brand.logoUrl,
      appUrl: brand.appUrl,
      supportEmail: brand.supportEmail,
    });
    await deps.email.send({ to: host.email, from: env.MAIL_FROM?.trim() || host.email, subject: heading, text, html });
  } catch (error) {
    console.error({ meetingId: meeting.id, error: error instanceof Error ? error.message : String(error) }, "host booking email failed");
  }
}

/**
 * Books a call. In order: the slot is checked against the diary and the
 * settings; the provider meeting is created *outside* any transaction (an HTTP
 * call never holds a lock); then one transaction writes the row, the audit
 * and timeline entries, moves a `new` lead to `contacted` and queues the
 * guest's confirmation. The unique index on `(host, starts_at)` for live
 * meetings is the final word on a race — a second booker gets
 * `MeetingRefused("slot_taken")` and the provider meeting we made for them is
 * deleted. After commit: the host's bell and phone (`meeting.booked`), the
 * optional host email, and `message.queued` for the confirmation.
 *
 * Anchoring: `leadId` files it under a lead, `clientId` under a client, and
 * neither mints a lead (`source: booking`, no acknowledgement — the
 * confirmation is the first email) so every meeting has a thread.
 */
export async function bookMeeting(
  db: Db,
  organisationId: string,
  input: BookMeetingInput,
  deps: MeetingDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BookMeetingResult> {
  const v = BookMeetingInput.parse(input);
  const now = v.now ?? new Date();
  if (v.startsAt.getTime() <= now.getTime()) throw new MeetingRefused("past", "That time has already passed.");
  const { settings, hostUserId } = await resolveBookingHost(db, organisationId);
  if (!(await isSlotAvailable(db, organisationId, v.startsAt, { now }))) {
    throw new MeetingRefused("slot_taken", "That time is no longer available — please pick another.");
  }
  if (v.leadId) await assertOwned(db, organisationId, schema.leads, v.leadId);
  if (v.clientId) await assertOwned(db, organisationId, schema.clients, v.clientId);

  let leadId = v.leadId ?? null;
  const clientId = v.clientId ?? null;
  if (!leadId && !clientId) {
    const lead = await createLead(db, organisationId, {
      name: v.guestName, email: v.guestEmail, source: "booking", acknowledge: false, notifyOwner: false,
      ...(v.notes ? { message: v.notes } : {}), actorKind: v.actorKind, ...(v.actorId ? { actorId: v.actorId } : {}),
    }, env);
    leadId = lead.id;
  }

  const endsAt = new Date(v.startsAt.getTime() + settings.slotMinutes * 60_000);
  const host = await hostDetails(db, hostUserId);
  let provider;
  try {
    provider = await deps.meetings.createMeeting({
      topic: `LaunchFlow ${v.kind} call with ${v.guestName}`,
      startsAt: v.startsAt,
      durationMinutes: settings.slotMinutes,
      timezone: settings.timezone,
      hostEmail: host.email,
      ...(v.notes ? { agenda: v.notes } : {}),
    });
  } catch (error) {
    throw new MeetingRefused("provider_failed", `The call could not be created: ${error instanceof Error ? error.message : String(error)}`);
  }

  let created;
  try {
    created = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [meeting] = await tx.insert(schema.meetings).values({
        organisationId,
        kind: v.kind,
        leadId,
        clientId,
        hostUserId,
        guestName: v.guestName,
        guestEmail: v.guestEmail.toLowerCase(),
        guestTimezone: v.guestTimezone,
        startsAt: v.startsAt,
        endsAt,
        status: "scheduled",
        provider: deps.meetings.name,
        providerMeetingId: provider.providerMeetingId,
        joinUrl: provider.joinUrl,
        hostUrl: provider.hostUrl,
        rescheduleToken: mintRescheduleToken(),
        notes: v.notes ?? null,
        metadata: { source: v.source, sequence: 0, bookedByKind: v.actorKind, ...(v.actorId ? { bookedById: v.actorId } : {}) },
      }).returning();
      await recordAudit(tx, organisationId, {
        actorKind: v.actorKind, actorId: v.actorId, action: "meeting.booked", targetType: "meeting", targetId: meeting!.id, after: meeting,
      });
      await recordActivity(tx, organisationId, {
        ...(clientId ? { clientId } : {}),
        actorKind: v.actorKind, actorId: v.actorId, kind: "meeting.booked",
        title: `${v.guestName} booked a ${v.kind} call for ${formatInZone(v.startsAt, settings.timezone, "short")}`,
        link: `/meetings/${meeting!.id}`,
      });
      if (leadId) await markLeadContacted(tx, organisationId, leadId, { actorKind: v.actorKind, actorId: v.actorId });
      const confirmation = await queueMeetingNotice(tx, organisationId, {
        meeting: meeting!, notice: "confirmation",
        subject: `Your call with LaunchFlow: ${formatInZone(v.startsAt, v.guestTimezone, "short")}`,
        body: confirmationBody(meeting!, settings.timezone, env),
        links: { joinUrl: meeting!.joinUrl, manageUrl: meetingManageUrl(meeting!, env) },
        actorKind: v.actorKind, actorId: v.actorId,
      }, env);
      return { meeting: meeting!, confirmation };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      await deps.meetings.deleteMeeting(provider.providerMeetingId).catch(() => undefined);
      throw new MeetingRefused("slot_taken", "Somebody took that time a moment ago — please pick another.");
    }
    throw error;
  }

  const { meeting, confirmation } = created;
  await notify(db, organisationId, {
    userId: hostUserId,
    kind: MEETING_BOOKED_NOTIFICATION_KIND,
    title: `Call booked: ${meeting.guestName}, ${formatInZone(meeting.startsAt, settings.timezone, "short")}`,
    body: [meeting.guestEmail, meeting.notes].filter(Boolean).join("\n"),
    link: `/meetings/${meeting.id}`,
  });
  await emailHost(deps, db, meeting, settings.timezone, env);
  await emit({ name: "message.queued", organisationId, messageId: confirmation.id });

  return {
    meeting, leadId, clientId, confirmation,
    manageUrl: meetingManageUrl(meeting, env),
    icsUrl: meetingIcsUrl(meeting, env),
  };
}

/** The `.ics` for a meeting — `METHOD:CANCEL` once it is cancelled, `REQUEST` otherwise, `SEQUENCE` from the metadata. */
export async function meetingIcs(db: Db, meeting: MeetingRow, env: NodeJS.ProcessEnv = process.env): Promise<{ filename: string; ics: string }> {
  const host = await hostDetails(db, meeting.hostUserId);
  const brand = brandEmailContext(env);
  const sequence = typeof meeting.metadata["sequence"] === "number" ? (meeting.metadata["sequence"] as number) : 0;
  const ics = buildIcs({
    uid: `${meeting.id}@launchos`,
    method: meeting.status === "cancelled" ? "CANCEL" : "REQUEST",
    sequence,
    startsAt: meeting.startsAt,
    endsAt: meeting.endsAt,
    summary: `LaunchFlow call with ${host.name}`,
    description: `Join: ${meeting.joinUrl}\nChange or cancel: ${meetingManageUrl(meeting, env)}`,
    location: meeting.joinUrl,
    url: meeting.joinUrl,
    organiser: { name: host.name, email: brand.supportEmail },
    attendee: { name: meeting.guestName, email: meeting.guestEmail },
    stamp: meeting.updatedAt,
  });
  return { filename: `launchflow-call-${meeting.startsAt.toISOString().slice(0, 10)}.ics`, ics };
}

/** The `.ics` by reschedule token, for the public route: null for an unknown token. */
export async function meetingIcsByToken(db: Db, token: string, env: NodeJS.ProcessEnv = process.env): Promise<{ filename: string; ics: string } | null> {
  const trimmed = token.trim();
  if (trimmed.length < 16 || trimmed.length > 128) return null;
  const [meeting] = await db.select().from(schema.meetings).where(and(eq(schema.meetings.rescheduleToken, trimmed))).limit(1);
  if (!meeting) return null;
  return meetingIcs(db, meeting, env);
}
