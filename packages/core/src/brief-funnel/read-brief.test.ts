import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockBriefWriter } from "@launchos/integrations";
import { describe, expect, it } from "vitest";
import { captureLeadFromDraft } from "./capture.js";
import { briefForLead, draftProgressForLead } from "./read-brief.js";
import { completeBriefStep, patchBriefSession, startBriefSession } from "./sessions.js";
import { submitBrief } from "./submit.js";
import { writeBriefVersion } from "./write-brief.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

const COMPLETE = {
  name: "Sam Taylor", phone: "07700900123",
  business: "Taylor Plumbing", industry: "Plumbing and heating",
  goals: ["enquiries"], designDirection: "clean",
  pages: ["home", "contact"], budget: "1500_3000", timeline: ["asap"],
};

/** A draft with a lead attached and whatever answers are given. */
async function draftFor(db: Db, orgId: string, answers: Record<string, unknown>) {
  const { session } = await startBriefSession(db, orgId);
  await patchBriefSession(db, orgId, session.id, {
    mutationId: crypto.randomUUID(), expectedRevision: 0, fields: answers,
  });
  const { leadId } = await captureLeadFromDraft(db, orgId, session.id, {
    name: String(answers.name ?? "Sam"), phone: "07700900123",
  });
  return { sessionId: session.id, leadId: leadId! };
}

describe("briefForLead", () => {
  it("finds the brief behind a lead, with its reference and answers", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { sessionId, leadId } = await draftFor(db, org.id, COMPLETE);
      await submitBrief(db, org.id, sessionId, { idempotencyKey: "press-key-one", expectedRevision: 1 });

      const brief = await briefForLead(db, org.id, leadId);

      expect(brief?.reference).toMatch(/^LF-/);
      expect(brief?.answers.business).toBe("Taylor Plumbing");
      expect(brief?.markdown).toContain("Taylor Plumbing");
      expect(brief?.version).toBe(1);
    });
  });

  /**
   * A plain brief and a written one are both legitimate, but a screen that
   * shows them identically is one where nobody notices the AI stopped working.
   */
  it("says whether the brief writer has been over it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { sessionId, leadId } = await draftFor(db, org.id, COMPLETE);
      const submission = await submitBrief(db, org.id, sessionId, { idempotencyKey: "press-key-one", expectedRevision: 1 });
      if (submission.status !== "submitted") throw new Error("expected a submission");

      expect((await briefForLead(db, org.id, leadId))?.awaitingWriter).toBe(true);

      await writeBriefVersion(db, org.id, submission.submissionId, new MockBriefWriter());

      const after = await briefForLead(db, org.id, leadId);
      expect(after?.awaitingWriter).toBe(false);
      expect(after?.version).toBe(2);
      expect(after?.model).toBe("mock");
      expect(after?.structured).not.toBeNull();
    });
  });

  it("gives nothing for a lead that never used the questionnaire", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const [lead] = await db
        .insert(schema.leads)
        .values({ organisationId: org.id, name: "Walk-in", source: "manual" })
        .returning();

      expect(await briefForLead(db, org.id, lead!.id)).toBeNull();
    });
  });

  it("gives nothing while the questionnaire is still being filled in", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { leadId } = await draftFor(db, org.id, COMPLETE);

      expect(await briefForLead(db, org.id, leadId)).toBeNull();
    });
  });

  it("does not reach across organisations", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      const { sessionId, leadId } = await draftFor(db, mine.id, COMPLETE);
      await submitBrief(db, mine.id, sessionId, { idempotencyKey: "press-key-one", expectedRevision: 1 });

      expect(await briefForLead(db, theirs.id, leadId)).toBeNull();
    });
  });
});

describe("draftProgressForLead", () => {
  /**
   * Knowing somebody reached stage six and went quiet is the difference
   * between a cold call and a useful one.
   */
  it("reports how far an unfinished draft got", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { sessionId, leadId } = await draftFor(db, org.id, { name: "Sam", phone: "07700900123", business: "Taylor Plumbing", industry: "Plumbing" });
      await completeBriefStep(db, org.id, sessionId, 1);
      await completeBriefStep(db, org.id, sessionId, 2);

      const progress = await draftProgressForLead(db, org.id, leadId);

      expect(progress?.currentStep).toBe(3);
      expect(progress?.completedSteps).toEqual([1, 2]);
      expect(progress?.answers.business).toBe("Taylor Plumbing");
    });
  });

  it("stops reporting progress once the brief has been sent", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { sessionId, leadId } = await draftFor(db, org.id, COMPLETE);
      await submitBrief(db, org.id, sessionId, { idempotencyKey: "press-key-one", expectedRevision: 1 });

      expect(await draftProgressForLead(db, org.id, leadId)).toBeNull();
    });
  });
});
