import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { classifyEnquiry, ingestInboundEnquiry, isSuppressed } from "./inbound-enquiry.js";
import { createLead, updateLeadStatus } from "./leads.js";
import { normalisePhone } from "./phone.js";

const SHOJI_MOBILE = "07700 900123";
const E164 = "+447700900123";

async function suppress(db: Parameters<typeof isSuppressed>[0], organisationId: string, phone: string, note?: string) {
  await db.insert(schema.leadSuppressions).values({
    organisationId, phone: normalisePhone(phone), note: note ?? null,
  });
}

/** The local test database is shared, so every read is scoped to its tenant. */
async function leadsOf(db: Parameters<typeof isSuppressed>[0], organisationId: string) {
  return db.select().from(schema.leads).where(eq(schema.leads.organisationId, organisationId));
}

async function auditOf(db: Parameters<typeof isSuppressed>[0], organisationId: string) {
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.organisationId, organisationId));
}

describe("normalisePhone", () => {
  it("squares up every way a UK number gets written, so one person is one row", () => {
    for (const written of ["07700 900123", "+44 7700 900123", "447700900123", "+447700900123", "00447700900123", "0 7700-900123"]) {
      expect(normalisePhone(written)).toBe(E164);
    }
  });

  it("leaves an unrecognised number usable rather than mangling or refusing it", () => {
    expect(normalisePhone("+1 415 555 0100")).toBe("+14155550100");
    expect(normalisePhone("12345")).toBe("12345");
    expect(normalisePhone("  ")).toBe("");
  });
});

describe("classifyEnquiry", () => {
  it("reads an enquiry as one, and says which words decided it", () => {
    const v = classifyEnquiry("Hi, how much for a website for my building company?");
    expect(v.isEnquiry).toBe(true);
    expect(v.matched).toContain("website");
    expect(v.matched).toContain("how much");
    expect(v.reason).toContain("website");
  });

  it("leaves ordinary life alone — the expensive mistake is the false positive", () => {
    for (const text of [
      "Assalam o alaikum bhai, are you coming tomorrow?",
      "Can you pick the boys up at 4",
      "ok",
      "Ghusa ghat kita kro",
      "Running late, be there in 10 minutes mate",
    ]) {
      expect(classifyEnquiry(text).isEnquiry, text).toBe(false);
    }
  });

  it("refuses two words in a row as a brief", () => {
    expect(classifyEnquiry("website").isEnquiry).toBe(false);
    expect(classifyEnquiry("need website").isEnquiry).toBe(false);
    expect(classifyEnquiry("i need website").isEnquiry).toBe(true);
  });
});

describe("ingestInboundEnquiry", () => {
  it("turns an enquiry into a lead the Lead Qualifier can pick up", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);

      const out = await ingestInboundEnquiry(db, organisationId, {
        channel: "sms",
        from: SHOJI_MOBILE,
        body: "Hello, I need a website for my landscaping business. How much?",
        externalId: "SM123",
      });

      expect(out.action).toBe("lead_created");
      if (out.action !== "lead_created") return;

      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, out.leadId));
      expect(lead).toMatchObject({ phone: E164, source: "sms", status: "new" });
      expect(lead!.message).toContain("landscaping");
      // The number is the name until Shoji knows better; nothing is invented.
      expect(lead!.name).toBe(E164);
      expect(lead!.metadata).toMatchObject({ inbound: true, externalId: "SM123" });
    });
  });

  it("never writes a lead for a suppressed number, whatever it says", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      await suppress(db, organisationId, "+44 7700 900123", "Shumaila");

      // Written differently from the way it was suppressed, and still caught.
      const out = await ingestInboundEnquiry(db, organisationId, {
        channel: "sms", from: "07700900123",
        body: "How much would a new website cost for the shop?",
      });

      expect(out).toEqual({ action: "suppressed", phone: E164 });
      expect(await leadsOf(db, organisationId)).toHaveLength(0);
      // Not even an audit line: a suppressed number's words are not our business.
      const audits = await auditOf(db, organisationId);
      expect(audits.filter((a) => a.action.startsWith("lead."))).toHaveLength(0);
    });
  });

  it("ignores a message that is not about the work, and records why without keeping it", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);

      const out = await ingestInboundEnquiry(db, organisationId, {
        channel: "sms", from: SHOJI_MOBILE, body: "Are you coming to dinner tonight?",
      });

      expect(out.action).toBe("ignored");
      expect(await leadsOf(db, organisationId)).toHaveLength(0);

      const [audit] = await db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.organisationId, organisationId),
        eq(schema.auditLog.action, "lead.inbound_ignored"),
      ));
      expect(audit).toBeTruthy();
      expect(JSON.stringify(audit!.after)).not.toContain("dinner");
    });
  });

  it("keeps one person to one lead however many times they message", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);

      const first = await ingestInboundEnquiry(db, organisationId, {
        channel: "sms", from: SHOJI_MOBILE, body: "Do you build websites? How much?",
      });
      const second = await ingestInboundEnquiry(db, organisationId, {
        channel: "sms", from: SHOJI_MOBILE, body: "Also do you do google ads pricing?",
      });

      expect(first.action).toBe("lead_created");
      expect(second.action).toBe("already_open");
      if (first.action !== "lead_created" || second.action !== "already_open") return;
      expect(second.leadId).toBe(first.leadId);
      expect(await leadsOf(db, organisationId)).toHaveLength(1);
    });
  });

  it("lets somebody who was lost come back as a new lead", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const old = await createLead(db, organisationId, { name: "Old", phone: E164, source: "sms" });
      await updateLeadStatus(db, organisationId, { leadId: old.id, status: "lost", actorId: ownerUserId });

      const out = await ingestInboundEnquiry(db, organisationId, {
        channel: "sms", from: SHOJI_MOBILE, body: "Hi again, still after a website quote please",
      });

      expect(out.action).toBe("lead_created");
      if (out.action !== "lead_created") return;
      expect(out.leadId).not.toBe(old.id);
    });
  });

  it("keeps one organisation's suppression list out of another's", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await suppress(db, a.organisationId, SHOJI_MOBILE);

      expect(await isSuppressed(db, a.organisationId, E164)).toBe(true);
      expect(await isSuppressed(db, b.organisationId, E164)).toBe(false);

      const out = await ingestInboundEnquiry(db, b.organisationId, {
        channel: "sms", from: SHOJI_MOBILE, body: "Can you quote for a website please",
      });
      expect(out.action).toBe("lead_created");
    });
  });
});
