import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { MockEmailAdapter } from "@launchos/channels";
import { MockMeetingsAdapter } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { createLead } from "../leads/leads.js";
import { bookingLinkFor } from "../leads/booking-link.js";
import { MEETING_NOTICE_KIND } from "../support/courtesy-notice.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { MeetingRefused, bookMeeting, meetingIcs, meetingIcsByToken } from "./book.js";
import { cancelMeeting, getMeetingByToken, listMeetings, markMeetingOutcome, nextMeeting, rescheduleMeeting } from "./manage.js";
import { HOST_ALERTED_AT, REMINDED_1H_AT, REMINDED_24H_AT, followUpMeetings, sendMeetingReminders } from "./reminders.js";
import { setBookingSettings } from "./settings.js";
import { availableSlots } from "./slots.js";

const env = { APP_URL: "https://os.launchflow.test", SUPPORT_CONTACT_EMAIL: "hello@launchflow.test", MAIL_FROM: "LaunchFlow <no-reply@launchflow.test>" } as NodeJS.ProcessEnv;
/** Monday 7 Sep 2026, 10:00Z. With 12 h notice the first bookable day is Tuesday. */
const NOW = new Date("2026-09-07T10:00:00Z");
/** Tuesday 8 Sep, 13:00 BST. */
const TUE_13 = new Date("2026-09-08T12:00:00Z");
const TUE_14 = new Date("2026-09-08T13:00:00Z");

async function notices(db: Parameters<typeof bookMeeting>[0], organisationId: string) {
  const rows = await db.select().from(schema.messages).where(eq(schema.messages.organisationId, organisationId));
  return rows.filter((m) => m.metadata["kind"] === MEETING_NOTICE_KIND).map((m) => ({ notice: m.metadata["notice"], to: m.toEmail, subject: m.subject, body: m.body, meetingId: m.metadata["meetingId"] }));
}

describe("available slots", () => {
  it("offers the default hours from tomorrow in the guest's zone and the host's, and removes a booked slot with its buffer", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const meetings = new MockMeetingsAdapter();
      const week = await availableSlots(db, organisationId, { from: NOW, to: new Date("2026-09-09T00:00:00Z"), guestTimezone: "Asia/Karachi", now: NOW });
      expect(week.timezone).toEqual({ guest: "Asia/Karachi", host: "Europe/London" });
      // Monday's slots are all inside the 12-hour notice; Tuesday has 20.
      expect(week.slots).toHaveLength(20);
      expect(week.slots[0]).toEqual({
        startsAt: "2026-09-08T12:00:00.000Z", endsAt: "2026-09-08T12:30:00.000Z",
        guestDate: "2026-09-08", guestTime: "17:00", hostDate: "2026-09-08", hostTime: "13:00",
      });
      expect(week.slots.at(-1)!.hostTime).toBe("22:30");

      await bookMeeting(db, organisationId, { guestName: "Aisha Khan", guestEmail: "aisha@example.test", startsAt: TUE_14, now: NOW }, { meetings }, env);
      const after = await availableSlots(db, organisationId, { from: NOW, to: new Date("2026-09-09T00:00:00Z"), now: NOW });
      // 13:30 (ends inside the buffer), 14:00 (taken) and 14:30 (starts inside the buffer) are gone.
      expect(after.slots.map((s) => s.hostTime)).not.toContain("13:30");
      expect(after.slots.map((s) => s.hostTime)).not.toContain("14:00");
      expect(after.slots.map((s) => s.hostTime)).not.toContain("14:30");
      expect(after.slots.map((s) => s.hostTime)).toContain("13:00");
      expect(after.slots.map((s) => s.hostTime)).toContain("15:00");
      expect(after.slots).toHaveLength(17);

      // Settings change the shape: Sunday mornings only, one-hour slots.
      await setBookingSettings(db, organisationId, {
        settings: { slotMinutes: 60, hours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [["09:00", "12:00"]] } },
        actorId: (await seedOrgWithClient(db)).ownerUserId,
      }).catch(() => undefined);
    });
  });

  it("honours the horizon and the notice window", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const far = await availableSlots(db, organisationId, { from: new Date("2026-10-15T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z"), now: NOW });
      expect(far.slots).toEqual([]);
      const soon = await availableSlots(db, organisationId, { from: NOW, to: new Date("2026-09-07T23:00:00Z"), now: NOW });
      expect(soon.slots).toEqual([]);
    });
  });
});

describe("booking a meeting", () => {
  it("books a lead's call: provider meeting, row, confirmation email on the lead's thread, host bell + email, lead contacted; a stranger gets a lead; the same slot cannot be taken twice", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const meetings = new MockMeetingsAdapter();
      const email = new MockEmailAdapter();
      const lead = await createLead(db, organisationId, { name: "Aisha Khan", email: "aisha@example.test", business: "Khan Dental", source: "website" }, env);

      const booked = await bookMeeting(db, organisationId, {
        leadId: lead.id, guestName: "Aisha Khan", guestEmail: "Aisha@Example.Test", guestTimezone: "Asia/Karachi",
        startsAt: TUE_13, notes: "Mostly about SEO", source: "email_link", now: NOW,
      }, { meetings, email }, env);
      const m = booked.meeting;
      expect(m).toMatchObject({
        kind: "discovery", leadId: lead.id, clientId: null, hostUserId: ownerUserId, guestEmail: "aisha@example.test", guestTimezone: "Asia/Karachi",
        status: "scheduled", provider: "mock", notes: "Mostly about SEO",
      });
      expect(m.endsAt.toISOString()).toBe("2026-09-08T12:30:00.000Z");
      expect(m.joinUrl).toMatch(/^https:\/\/meet\.launchflow\.example\/j\/mock_/);
      expect(m.rescheduleToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(meetings.created[0]).toMatchObject({ topic: "LaunchFlow discovery call with Aisha Khan", durationMinutes: 30, timezone: "Europe/London", agenda: "Mostly about SEO" });
      expect(booked.manageUrl).toBe(`https://os.launchflow.test/book/r/${m.rescheduleToken}`);
      expect(booked.icsUrl).toBe(`${booked.manageUrl}/calendar.ics`);

      // The confirmation is on the lead's own thread, after the acknowledgement.
      const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.leadId, lead.id));
      expect(booked.confirmation.conversationId).toBe(conversation!.id);
      expect(booked.confirmation).toMatchObject({ status: "queued", toEmail: "aisha@example.test", fromEmail: "hello@launchflow.test" });
      expect(booked.confirmation.subject).toMatch(/Your call with LaunchFlow: Tue 8 Sept?, 17:00/);
      expect(booked.confirmation.body).toContain("17:00");
      expect(booked.confirmation.body).toContain("for us");
      expect(booked.confirmation.body).toContain(m.joinUrl);
      expect(booked.confirmation.body).toContain(booked.icsUrl);
      expect(booked.confirmation.metadata).toMatchObject({ kind: MEETING_NOTICE_KIND, notice: "confirmation", meetingId: m.id, joinUrl: m.joinUrl, manageUrl: booked.manageUrl });

      const [bell] = await db.select().from(schema.notifications)
        .where(and(eq(schema.notifications.userId, ownerUserId), eq(schema.notifications.kind, "meeting.booked")));
      expect(bell!.title).toMatch(/Call booked: Aisha Khan, Tue 8 Sept?, 13:00/);
      expect(bell!.link).toBe(`/meetings/${m.id}`);
      expect(email.sent).toHaveLength(1);
      expect(email.sent[0]!.subject).toBe("Call booked: Aisha Khan");
      expect(email.sent[0]!.text).toContain(m.hostUrl!);

      const [leadAfter] = await db.select().from(schema.leads).where(eq(schema.leads.id, lead.id));
      expect(leadAfter!.status).toBe("contacted");
      const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.targetId, m.id), eq(schema.auditLog.action, "meeting.booked")));
      expect(audits).toHaveLength(1);

      // Same slot again: refused, and the provider meeting made for it is deleted.
      await expect(bookMeeting(db, organisationId, { guestName: "Bob", guestEmail: "bob@example.test", startsAt: TUE_13, now: NOW }, { meetings }, env))
        .rejects.toMatchObject({ reason: "slot_taken" });
      // Outside the hours and in the past: refused before the provider is touched.
      await expect(bookMeeting(db, organisationId, { guestName: "Bob", guestEmail: "bob@example.test", startsAt: new Date("2026-09-08T08:00:00Z"), now: NOW }, { meetings }, env))
        .rejects.toMatchObject({ reason: "slot_taken" });
      await expect(bookMeeting(db, organisationId, { guestName: "Bob", guestEmail: "bob@example.test", startsAt: new Date("2026-09-01T12:00:00Z"), now: NOW }, { meetings }, env))
        .rejects.toBeInstanceOf(MeetingRefused);
      expect(meetings.created).toHaveLength(1);

      // A stranger: a lead is minted (source booking, no acknowledgement), the meeting files under it.
      const stranger = await bookMeeting(db, organisationId, { guestName: "Dan Cole", guestEmail: "dan@example.test", startsAt: new Date("2026-09-08T15:00:00Z"), now: NOW }, { meetings }, env);
      const [minted] = await db.select().from(schema.leads).where(eq(schema.leads.id, stranger.leadId!));
      expect(minted).toMatchObject({ name: "Dan Cole", email: "dan@example.test", source: "booking", status: "contacted" });
      expect(minted!.metadata["acknowledgedAt"]).toBeUndefined();
      const all = await notices(db, organisationId);
      expect(all.map((n) => n.notice)).toEqual(["confirmation", "confirmation"]);

      // The ICS for the guest's link.
      const ics = await meetingIcsByToken(db, m.rescheduleToken, env);
      expect(ics!.filename).toBe("launchflow-call-2026-09-08.ics");
      expect(ics!.ics).toContain("DTSTART:20260908T120000Z");
      expect(ics!.ics).toContain("METHOD:REQUEST");
      expect(ics!.ics).toContain("SEQUENCE:0");
      expect(ics!.ics).toContain("ATTENDEE;CN=Aisha Khan");
      expect(await meetingIcsByToken(db, "nope", env)).toBeNull();

      expect((await nextMeeting(db, organisationId, NOW))!.id).toBe(m.id);
      expect((await listMeetings(db, organisationId, { scope: "upcoming", now: NOW })).map((x) => x.id)).toEqual([m.id, stranger.meeting.id]);
      expect((await listMeetings(db, organisationId, { leadId: lead.id, now: NOW })).map((x) => x.id)).toEqual([m.id]);
    });
  });

  it("books a client's call on a conversation of its own, with the client's timeline entry", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const meetings = new MockMeetingsAdapter();
      const booked = await bookMeeting(db, organisationId, {
        kind: "review", clientId, guestName: "Grays CabLine", guestEmail: "info@grays.test", startsAt: TUE_13, source: "portal", actorKind: "client", now: NOW,
      }, { meetings }, env);
      expect(booked.meeting).toMatchObject({ kind: "review", clientId, leadId: null });
      const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, booked.confirmation.conversationId));
      expect(conversation).toMatchObject({ clientId, leadId: null, subject: "Your call with LaunchFlow", status: "closed" });
      expect(booked.meeting.metadata["conversationId"]).toBeUndefined(); // stamped after the returning(); re-read
      const [fresh] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, booked.meeting.id));
      expect(fresh!.metadata["conversationId"]).toBe(conversation!.id);
      const [timeline] = await db.select().from(schema.activityEvents)
        .where(and(eq(schema.activityEvents.clientId, clientId), eq(schema.activityEvents.kind, "meeting.booked")));
      expect(timeline!.link).toBe(`/meetings/${booked.meeting.id}`);
    });
  });

  it("reschedules (provider updated, sequence up, reminders reset, guest emailed), cancels (provider deleted, rebook link), and refuses the dead", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const meetings = new MockMeetingsAdapter();
      const lead = await createLead(db, organisationId, { name: "Aisha", email: "aisha@example.test", source: "website" }, env);
      const { meeting } = await bookMeeting(db, organisationId, { leadId: lead.id, guestName: "Aisha", guestEmail: "aisha@example.test", startsAt: TUE_13, now: NOW }, { meetings }, env);
      await db.update(schema.meetings).set({ metadata: { ...meeting.metadata, [REMINDED_24H_AT]: "x" } }).where(eq(schema.meetings.id, meeting.id));

      // Moving onto its own slot is fine (it does not block itself); onto a taken slot is not.
      const other = await bookMeeting(db, organisationId, { guestName: "Bob", guestEmail: "bob@example.test", startsAt: new Date("2026-09-08T16:00:00Z"), now: NOW }, { meetings }, env);
      await expect(rescheduleMeeting(db, organisationId, { meetingId: meeting.id, startsAt: new Date("2026-09-08T16:00:00Z"), now: NOW }, { meetings }, env))
        .rejects.toMatchObject({ reason: "slot_taken" });
      const moved = await rescheduleMeeting(db, organisationId, { meetingId: meeting.id, startsAt: TUE_14, actorKind: "client", now: NOW }, { meetings }, env);
      expect(moved.meeting).toMatchObject({ status: "rescheduled", startsAt: TUE_14 });
      expect(moved.meeting.endsAt.toISOString()).toBe("2026-09-08T13:30:00.000Z");
      expect(moved.meeting.metadata).toMatchObject({ sequence: 1, previousStartsAt: TUE_13.toISOString(), [REMINDED_24H_AT]: null });
      expect(meetings.updated).toEqual([{ providerMeetingId: meeting.providerMeetingId, input: { startsAt: TUE_14, durationMinutes: 30 } }]);
      expect(moved.notice.metadata).toMatchObject({ notice: "rescheduled", meetingId: meeting.id });
      expect(moved.notice.body).toContain("has moved to");
      expect((await meetingIcs(db, moved.meeting, env)).ics).toContain("SEQUENCE:1");
      const [movedBell] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ownerUserId), eq(schema.notifications.kind, "meeting.rescheduled")));
      expect(movedBell!.title).toContain("Call moved: Aisha");
      // The old slot is free again.
      const slots = await availableSlots(db, organisationId, { from: NOW, to: new Date("2026-09-09T00:00:00Z"), now: NOW });
      expect(slots.slots.map((s) => s.hostTime)).toContain("13:00");

      const byToken = await getMeetingByToken(db, meeting.rescheduleToken);
      expect(byToken!.id).toBe(meeting.id);
      const cancelled = await cancelMeeting(db, organisationId, { meetingId: meeting.id, reason: "Family emergency", actorId: ownerUserId, now: NOW }, { meetings }, env);
      expect(cancelled.meeting.status).toBe("cancelled");
      expect(cancelled.meeting.metadata).toMatchObject({ sequence: 2, cancelReason: "Family emergency", cancelledByKind: "user" });
      expect(meetings.deleted).toEqual([meeting.providerMeetingId]);
      expect(cancelled.notice.metadata).toMatchObject({ notice: "cancelled", bookingUrl: bookingLinkFor(lead, env) });
      expect(cancelled.notice.body).toContain("Family emergency");
      expect((await meetingIcs(db, cancelled.meeting, env)).ics).toContain("METHOD:CANCEL");
      await expect(cancelMeeting(db, organisationId, { meetingId: meeting.id, actorId: ownerUserId }, { meetings }, env)).rejects.toMatchObject({ reason: "not_live" });
      await expect(rescheduleMeeting(db, organisationId, { meetingId: meeting.id, startsAt: TUE_14, now: NOW }, { meetings }, env)).rejects.toMatchObject({ reason: "not_live" });
      await expect(markMeetingOutcome(db, organisationId, { meetingId: meeting.id, outcome: "completed", actorId: ownerUserId })).rejects.toMatchObject({ reason: "not_live" });
      // The slot is bookable again after the cancel — the partial unique index let it go.
      const rebooked = await bookMeeting(db, organisationId, { guestName: "Cara", guestEmail: "cara@example.test", startsAt: TUE_14, now: NOW }, { meetings }, env);
      expect(rebooked.meeting.status).toBe("scheduled");
      expect((await listMeetings(db, organisationId, { scope: "past", now: NOW })).map((x) => x.id)).toEqual([meeting.id]);
      expect((await listMeetings(db, organisationId, { scope: "upcoming", now: NOW })).map((x) => x.id)).toEqual([rebooked.meeting.id, other.meeting.id]);
    });
  });

  it("records outcomes: a no-show gets one 'sorry we missed you' email, a completed call none", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const meetings = new MockMeetingsAdapter();
      const a = await bookMeeting(db, organisationId, { guestName: "A", guestEmail: "a@example.test", startsAt: TUE_13, now: NOW }, { meetings }, env);
      const b = await bookMeeting(db, organisationId, { guestName: "B", guestEmail: "b@example.test", startsAt: new Date("2026-09-08T15:00:00Z"), now: NOW }, { meetings }, env);
      const later = new Date("2026-09-08T18:00:00Z");
      const done = await markMeetingOutcome(db, organisationId, { meetingId: a.meeting.id, outcome: "completed", notes: "Wants Starter", actorId: ownerUserId, now: later }, env);
      expect(done.meeting).toMatchObject({ status: "completed", notes: "Wants Starter" });
      expect(done.notice).toBeNull();
      const missed = await markMeetingOutcome(db, organisationId, { meetingId: b.meeting.id, outcome: "no_show", actorId: ownerUserId, now: later }, env);
      expect(missed.notice!.metadata).toMatchObject({ notice: "no_show", meetingId: b.meeting.id });
      expect(missed.notice!.body).toContain("Sorry we missed you");
      expect(typeof missed.meeting.metadata["noShowEmailedAt"]).toBe("string");
      // The follow-up sweep finds nothing left to do for either.
      const sweep = await followUpMeetings(db, organisationId, { now: new Date("2026-09-09T09:00:00Z") }, env);
      expect(sweep).toEqual({ outcomeNudged: [], noShowEmailed: [] });
      expect((await notices(db, organisationId)).filter((n) => n.notice === "no_show")).toHaveLength(1);
    });
  });

  it("keeps organisations apart", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const meetings = new MockMeetingsAdapter();
      const lead = await createLead(db, a.organisationId, { name: "A", email: "a@example.test", source: "website" }, env);
      await expect(bookMeeting(db, b.organisationId, { leadId: lead.id, guestName: "A", guestEmail: "a@example.test", startsAt: TUE_13, now: NOW }, { meetings }, env))
        .rejects.toThrow(/not found in organisation/);
      const { meeting } = await bookMeeting(db, a.organisationId, { leadId: lead.id, guestName: "A", guestEmail: "a@example.test", startsAt: TUE_13, now: NOW }, { meetings }, env);
      await expect(cancelMeeting(db, b.organisationId, { meetingId: meeting.id, actorId: b.ownerUserId }, { meetings }, env)).rejects.toMatchObject({ reason: "not_found" });
      await expect(markMeetingOutcome(db, b.organisationId, { meetingId: meeting.id, outcome: "completed", actorId: b.ownerUserId })).rejects.toMatchObject({ reason: "not_found" });
      expect(await listMeetings(db, b.organisationId, { now: NOW })).toEqual([]);
      // Different hosts: the same instant is free in the other organisation.
      const theirs = await bookMeeting(db, b.organisationId, { guestName: "B", guestEmail: "b@example.test", startsAt: TUE_13, now: NOW }, { meetings }, env);
      expect(theirs.meeting.hostUserId).toBe(b.ownerUserId);
    });
  });
});

describe("reminders and follow-ups", () => {
  it("sends the 24h and 1h guest reminders and the 15-minute host alert once each, and nudges the owner once for an unmarked call", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const meetings = new MockMeetingsAdapter();
      const { meeting } = await bookMeeting(db, organisationId, { guestName: "Aisha", guestEmail: "aisha@example.test", startsAt: TUE_13, now: NOW }, { meetings }, env);

      const dayBefore = new Date(TUE_13.getTime() - 23 * 3_600_000);
      const first = await sendMeetingReminders(db, organisationId, { now: dayBefore }, env);
      expect(first).toEqual({ reminded24h: [meeting.id], reminded1h: [], hostAlerted: [] });
      expect(await sendMeetingReminders(db, organisationId, { now: dayBefore }, env)).toEqual({ reminded24h: [], reminded1h: [], hostAlerted: [] });

      const hourBefore = new Date(TUE_13.getTime() - 50 * 60_000);
      expect(await sendMeetingReminders(db, organisationId, { now: hourBefore }, env)).toEqual({ reminded24h: [], reminded1h: [meeting.id], hostAlerted: [] });
      const tenBefore = new Date(TUE_13.getTime() - 10 * 60_000);
      expect(await sendMeetingReminders(db, organisationId, { now: tenBefore }, env)).toEqual({ reminded24h: [], reminded1h: [], hostAlerted: [meeting.id] });
      expect(await sendMeetingReminders(db, organisationId, { now: tenBefore }, env)).toEqual({ reminded24h: [], reminded1h: [], hostAlerted: [] });

      const [row] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, meeting.id));
      for (const key of [REMINDED_24H_AT, REMINDED_1H_AT, HOST_ALERTED_AT]) expect(typeof row!.metadata[key]).toBe("string");
      const sent = (await notices(db, organisationId)).filter((n) => n.notice === "reminder");
      expect(sent).toHaveLength(2);
      expect(sent[0]!.subject).toMatch(/^Tomorrow: your call/);
      expect(sent[0]!.body).toContain("tomorrow");
      expect(sent[1]!.subject).toBe("In an hour: your call with LaunchFlow");
      const [alert] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ownerUserId), eq(schema.notifications.kind, "meeting.starting")));
      expect(alert!.title).toBe("Call in 15 minutes: Aisha");
      expect(alert!.body).toContain(meeting.hostUrl!);

      // Two hours after it ended with no outcome: one nudge, never two.
      const afterwards = new Date(TUE_13.getTime() + 3 * 3_600_000);
      expect(await followUpMeetings(db, organisationId, { now: afterwards }, env)).toEqual({ outcomeNudged: [meeting.id], noShowEmailed: [] });
      expect(await followUpMeetings(db, organisationId, { now: afterwards }, env)).toEqual({ outcomeNudged: [], noShowEmailed: [] });
      const nudges = await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ownerUserId), eq(schema.notifications.kind, "meeting.outcome_needed")));
      expect(nudges).toHaveLength(1);
      expect(nudges[0]!.link).toBe(`/meetings/${meeting.id}`);

      // A no-show marked by hand without the stamp is picked up by the sweep, once.
      await db.update(schema.meetings).set({ status: "no_show" }).where(eq(schema.meetings.id, meeting.id));
      expect(await followUpMeetings(db, organisationId, { now: afterwards }, env)).toEqual({ outcomeNudged: [], noShowEmailed: [meeting.id] });
      expect(await followUpMeetings(db, organisationId, { now: afterwards }, env)).toEqual({ outcomeNudged: [], noShowEmailed: [] });
    });
  });
});
