import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { LEAD_ACKNOWLEDGEMENT_KIND, isCourtesyNoticeRow } from "../support/courtesy-notice.js";
import { LEAD_ACKNOWLEDGED_AT, LEAD_CONVERSATION_ID, queueLeadAcknowledgement } from "./acknowledge.js";
import { attributionOf } from "./attribution.js";
import { bookingLinkFor, bookingTokenOf, findLeadByBookingToken, findLeadByBookingTokenIn } from "./booking-link.js";
import { createLead, leadCampaignCounts, leadsAwaitingReply, listLeads } from "./leads.js";

const env = { APP_URL: "https://os.launchflow.test", SUPPORT_CONTACT_EMAIL: "hello@launchflow.test" } as NodeJS.ProcessEnv;

describe("lead acknowledgement", () => {
  it("queues one branded 'we've got your enquiry' email with the booking link for a website lead, stamps the lead, and never twice", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const lead = await createLead(db, organisationId, {
        name: "Aisha Khan", email: "Aisha@Example.Test", business: "Khan Dental", message: "Need a website", source: "website", actorKind: "client",
      }, env);

      const token = bookingTokenOf(lead);
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(bookingLinkFor(lead, env)).toBe(`https://os.launchflow.test/book?lead=${token}`);
      expect(typeof lead.metadata[LEAD_ACKNOWLEDGED_AT]).toBe("string");

      const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.leadId, lead.id));
      expect(conversation).toMatchObject({ clientId: null, leadId: lead.id, participantEmail: "aisha@example.test", channel: "email" });
      expect(lead.metadata[LEAD_CONVERSATION_ID]).toBe(conversation!.id);

      const messages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversation!.id));
      expect(messages).toHaveLength(1);
      const ack = messages[0]!;
      expect(ack).toMatchObject({ direction: "outbound", status: "queued", toEmail: "aisha@example.test", fromEmail: "hello@launchflow.test", subject: "We've got your enquiry" });
      expect(ack.metadata).toMatchObject({ kind: LEAD_ACKNOWLEDGEMENT_KIND, leadId: lead.id, bookingUrl: bookingLinkFor(lead, env) });
      expect(ack.body).toContain("Hi Aisha,");
      expect(ack.body).toContain("about Khan Dental");
      expect(ack.body).toContain("within one working day");
      expect(ack.body).toContain(bookingLinkFor(lead, env));
      expect(isCourtesyNoticeRow(ack.metadata)).toBe(true);

      // A second call finds the stamp and does nothing.
      expect(await queueLeadAcknowledgement(db, organisationId, { lead }, env)).toBeUndefined();
      const [fresh] = await db.select().from(schema.leads).where(eq(schema.leads.id, lead.id));
      expect(await queueLeadAcknowledgement(db, organisationId, { lead: { ...fresh!, metadata: {} } }, env)).toBeUndefined();
      expect(await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversation!.id))).toHaveLength(1);

      const timeline = await db.select().from(schema.activityEvents)
        .where(and(eq(schema.activityEvents.organisationId, organisationId), eq(schema.activityEvents.kind, "lead.acknowledged")));
      expect(timeline).toHaveLength(1);
      expect(timeline[0]!.link).toBe(`/leads/${lead.id}`);

      // Token lookup, across and within organisations.
      expect((await findLeadByBookingToken(db, token!))?.id).toBe(lead.id);
      expect(await findLeadByBookingToken(db, "short")).toBeNull();
      expect(await findLeadByBookingTokenIn(db, organisationId, token!)).not.toBeNull();
    });
  });

  it("does not acknowledge a manual lead, a lead without an email, or when the caller opts out", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      const manual = await createLead(db, organisationId, { name: "Bob", email: "bob@example.test", source: "manual" }, env);
      const noEmail = await createLead(db, organisationId, { name: "Cara", phone: "0770", source: "website" }, env);
      const optedOut = await createLead(db, organisationId, { name: "Dan", email: "dan@example.test", source: "website", acknowledge: false }, env);
      for (const lead of [manual, noEmail, optedOut]) {
        expect(lead.metadata[LEAD_ACKNOWLEDGED_AT]).toBeUndefined();
        expect(bookingTokenOf(lead)).not.toBeNull();
      }
      const notices = await db.select().from(schema.messages)
        .where(and(eq(schema.messages.organisationId, organisationId)));
      expect(notices.filter((m) => m.metadata["kind"] === LEAD_ACKNOWLEDGEMENT_KIND)).toHaveLength(0);
      // The manual lead has no thread yet either.
      expect(await db.select().from(schema.conversations).where(eq(schema.conversations.leadId, manual.id))).toHaveLength(0);
    });
  });

  it("links to the marketing contact page for a lead minted before tokens existed", () => {
    expect(bookingLinkFor({ metadata: {} }, { MARKETING_URL: "https://launchflow.test/" } as NodeJS.ProcessEnv)).toBe("https://launchflow.test/contact");
    expect(bookingLinkFor({ metadata: {} }, {} as NodeJS.ProcessEnv)).toBe("https://launchflow.co.uk/contact");
  });
});

describe("lead attribution and reporting", () => {
  it("stores compacted attribution, filters by campaign, counts per campaign over a window and names the campaign in the bell", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const spring = await createLead(db, organisationId, {
        name: "A", email: "a@example.test", source: "website",
        attribution: { utmSource: "google", utmMedium: "cpc", utmCampaign: "spring-launch", utmTerm: "", gclid: "abc" },
      }, env);
      expect(attributionOf(spring.metadata)).toEqual({ utmSource: "google", utmMedium: "cpc", utmCampaign: "spring-launch", gclid: "abc" });
      const [bell] = await db.select().from(schema.notifications)
        .where(and(eq(schema.notifications.userId, ownerUserId), eq(schema.notifications.link, `/leads/${spring.id}`)));
      expect(bell!.body).toContain("Campaign: google / cpc / spring-launch");

      await createLead(db, organisationId, { name: "B", source: "website", attribution: { utmCampaign: "spring-launch" } }, env);
      const plain = await createLead(db, organisationId, { name: "C", source: "manual", attribution: { utmSource: "" } }, env);
      expect(plain.metadata["attribution"]).toBeUndefined();

      const filtered = await listLeads(db, organisationId, { utmCampaign: "spring-launch" });
      expect(filtered.total).toBe(2);
      expect((await listLeads(db, organisationId, { utmCampaign: "nope" })).total).toBe(0);

      const counts = await leadCampaignCounts(db, organisationId, { days: 30 });
      expect(counts.campaigns).toEqual([
        { campaign: "spring-launch", leads: 2, converted: 0 },
        { campaign: null, leads: 1, converted: 0 },
      ]);
      // Outside the window: nothing.
      await db.update(schema.leads).set({ createdAt: new Date(Date.now() - 40 * 86_400_000) }).where(eq(schema.leads.organisationId, organisationId));
      expect((await leadCampaignCounts(db, organisationId, { days: 30 })).campaigns).toEqual([]);
    });
  });

  it("lists leads still new after the reply window, oldest first, and keeps organisations apart", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const now = new Date("2026-09-08T10:00:00Z");
      const old = await createLead(db, a.organisationId, { name: "Old" }, env);
      const older = await createLead(db, a.organisationId, { name: "Older" }, env);
      const recent = await createLead(db, a.organisationId, { name: "Recent" }, env);
      const other = await createLead(db, b.organisationId, { name: "Other org" }, env);
      // Same transaction, same now(): set the ages explicitly.
      await db.update(schema.leads).set({ createdAt: new Date(now.getTime() - 30 * 3_600_000) }).where(eq(schema.leads.id, old.id));
      await db.update(schema.leads).set({ createdAt: new Date(now.getTime() - 50 * 3_600_000) }).where(eq(schema.leads.id, older.id));
      await db.update(schema.leads).set({ createdAt: new Date(now.getTime() - 2 * 3_600_000) }).where(eq(schema.leads.id, recent.id));
      await db.update(schema.leads).set({ createdAt: new Date(now.getTime() - 90 * 3_600_000) }).where(eq(schema.leads.id, other.id));

      const waiting = await leadsAwaitingReply(db, a.organisationId, { hours: 24, now });
      expect(waiting.map((l) => l.id)).toEqual([older.id, old.id]);
    });
  });
});
