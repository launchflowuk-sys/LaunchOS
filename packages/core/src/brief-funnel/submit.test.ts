import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { captureLeadFromDraft } from "./capture.js";
import { patchBriefSession, startBriefSession } from "./sessions.js";
import { submitBrief } from "./submit.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

/** The client sends a UUID; anything shorter than eight characters is refused. */
const KEY_ONE = "press-key-one";
const KEY_TWO = "press-key-two";

const COMPLETE = {
  name: "Sam Taylor", phone: "07700900123",
  business: "Taylor Plumbing", industry: "Plumbing and heating",
  goals: ["enquiries", "bookings"], designDirection: "clean",
  pages: ["home", "contact"], budget: "1500_3000", timeline: ["asap"],
  bookingServices: "Boiler servicing\nEmergency callouts",
};

/** A draft filled in far enough to send, with its lead attached. */
async function readyDraft(db: Db, orgId: string, answers: Record<string, unknown> = COMPLETE) {
  const { session } = await startBriefSession(db, orgId);
  await patchBriefSession(db, orgId, session.id, {
    mutationId: crypto.randomUUID(), expectedRevision: 0, fields: answers,
  });
  await captureLeadFromDraft(db, orgId, session.id, {
    name: String(answers.name ?? "Sam"),
    ...(typeof answers.phone === "string" ? { phone: answers.phone } : {}),
  });
  return session.id;
}

describe("submitBrief", () => {
  it("freezes the answers, writes a brief and gives back a reference", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const sessionId = await readyDraft(db, org.id);

      const result = await submitBrief(db, org.id, sessionId, { idempotencyKey: KEY_ONE, expectedRevision: 1 });

      expect(result.status).toBe("submitted");
      if (result.status !== "submitted") return;
      expect(result.reference).toMatch(/^LF-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

      const [submission] = await db.select().from(schema.briefSubmissions).where(eq(schema.briefSubmissions.id, result.submissionId));
      expect(submission!.answers.business).toBe("Taylor Plumbing");
      expect(submission!.sourceRevision).toBe(1);

      const [session] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, sessionId));
      expect(session!.status).toBe("submitted");
    });
  });

  /**
   * The written brief exists before any model is asked for anything. An AI
   * outage has to be a missing improvement, never a lost enquiry.
   */
  it("writes a readable brief with no model involved", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const sessionId = await readyDraft(db, org.id);

      const result = await submitBrief(db, org.id, sessionId, { idempotencyKey: KEY_ONE, expectedRevision: 1 });
      if (result.status !== "submitted") throw new Error("expected a submission");

      const [version] = await db.select().from(schema.briefVersions).where(eq(schema.briefVersions.submissionId, result.submissionId));
      expect(version!.version).toBe(1);
      expect(version!.generatorVersion).toBe("deterministic-1");
      expect(version!.markdown).toContain("Taylor Plumbing");
      // The labels the customer saw, not the values we stored.
      expect(version!.markdown).toContain("More enquiries");
      expect(version!.markdown).not.toContain("1500_3000");
      expect(version!.markdown).toContain("£1,500 – £3,000");
    });
  });

  /** A double-tapped button, or a timeout the customer retried. */
  it("makes one submission out of a repeated press", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const sessionId = await readyDraft(db, org.id);

      const first = await submitBrief(db, org.id, sessionId, { idempotencyKey: KEY_ONE, expectedRevision: 1 });
      const again = await submitBrief(db, org.id, sessionId, { idempotencyKey: KEY_ONE, expectedRevision: 1 });

      if (first.status !== "submitted" || again.status !== "submitted") throw new Error("expected submissions");
      expect(again.submissionId).toBe(first.submissionId);
      expect(again.reference).toBe(first.reference);
      expect(again.replayed).toBe(true);

      const rows = await db.select().from(schema.briefSubmissions).where(eq(schema.briefSubmissions.sessionId, sessionId));
      expect(rows).toHaveLength(1);
      const versions = await db.select().from(schema.briefVersions).where(eq(schema.briefVersions.submissionId, first.submissionId));
      expect(versions).toHaveLength(1);
    });
  });

  it("refuses an unfinished draft and says which fields are missing", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const sessionId = await readyDraft(db, org.id, { name: "Sam", phone: "07700900123" });

      const result = await submitBrief(db, org.id, sessionId, { idempotencyKey: KEY_ONE, expectedRevision: 1 });

      expect(result.status).toBe("incomplete");
      if (result.status !== "incomplete") return;
      expect(result.errors.business).toBeDefined();
      expect(result.errors.budget).toBeDefined();

      const [session] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, sessionId));
      expect(session!.status).toBe("draft");
    });
  });

  it("moves the lead on and puts the answers on it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const sessionId = await readyDraft(db, org.id);

      await submitBrief(db, org.id, sessionId, { idempotencyKey: KEY_ONE, expectedRevision: 1 });

      const [session] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, sessionId));
      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, session!.leadId!));
      expect(lead!.status).toBe("qualified");
      expect(lead!.qualification.business).toBe("Taylor Plumbing");
    });
  });

  /**
   * Deselecting a goal takes its follow-up answers out of the requirements,
   * though they stay in the draft. The brief has to say so rather than either
   * reinstating them or dropping them silently.
   */
  it("leaves out-of-scope answers out of the submitted requirements, and names them", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const sessionId = await readyDraft(db, org.id, {
        ...COMPLETE,
        goals: ["enquiries"], // bookings removed; bookingServices is now hidden
      });

      const result = await submitBrief(db, org.id, sessionId, { idempotencyKey: KEY_ONE, expectedRevision: 1 });
      if (result.status !== "submitted") throw new Error("expected a submission");

      const [submission] = await db.select().from(schema.briefSubmissions).where(eq(schema.briefSubmissions.id, result.submissionId));
      expect(submission!.answers.bookingServices).toBeUndefined();

      const [version] = await db.select().from(schema.briefVersions).where(eq(schema.briefVersions.submissionId, result.submissionId));
      expect(version!.markdown).toContain("taken out of scope");
      expect(version!.markdown).toContain("What gets booked?");
    });
  });

  it("records the submission in the audit log", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const sessionId = await readyDraft(db, org.id);

      await submitBrief(db, org.id, sessionId, { idempotencyKey: KEY_ONE, expectedRevision: 1 });

      const audits = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, org.id), eq(schema.auditLog.action, "brief.submitted")));
      expect(audits).toHaveLength(1);
    });
  });

  /** References are quoted over the phone; two the same would be a real mess. */
  it("gives every submission its own reference", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const references = new Set<string>();
      for (let i = 0; i < 5; i += 1) {
        const sessionId = await readyDraft(db, org.id);
        const result = await submitBrief(db, org.id, sessionId, { idempotencyKey: `press-key-${i}`, expectedRevision: 1 });
        if (result.status === "submitted") references.add(result.reference);
      }
      expect(references.size).toBe(5);
    });
  });

  it("refuses a second submission on a brief already sent", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const sessionId = await readyDraft(db, org.id);
      await submitBrief(db, org.id, sessionId, { idempotencyKey: KEY_ONE, expectedRevision: 1 });

      await expect(
        submitBrief(db, org.id, sessionId, { idempotencyKey: KEY_TWO, expectedRevision: 1 }),
      ).rejects.toThrow(/already been sent/);
    });
  });
});
