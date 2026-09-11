import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { MockBriefWriter, type BriefWriterAdapter, type WrittenBrief } from "@launchos/integrations";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { captureLeadFromDraft } from "./capture.js";
import { patchBriefSession, startBriefSession } from "./sessions.js";
import { submitBrief } from "./submit.js";
import { MAX_BRIEF_WRITE_ATTEMPTS, submissionsAwaitingBrief, withoutContactDetails, writeBriefVersion } from "./write-brief.js";

/** An organisation with an owner, so the bell has somewhere to ring. */
async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const [owner] = await db
    .insert(schema.user)
    .values({ id: crypto.randomUUID(), name: "Shoji", email: `owner-${crypto.randomUUID()}@example.test`, emailVerified: true })
    .returning();
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: owner!.id, role: "owner", status: "active" });
  return org!;
}

const COMPLETE = {
  name: "Sam Taylor", phone: "07700900123", email: "sam@taylorplumbing.co.uk",
  addressLine1: "14 Example Street", city: "Grays", postcode: "RM17 0AA",
  business: "Taylor Plumbing", industry: "Plumbing and heating",
  goals: ["enquiries"], designDirection: "clean",
  pages: ["home", "contact"], features: ["enquiry_form"],
  budget: "1500_3000", timeline: ["asap"],
};

/** A submitted brief, with its deterministic version one already written. */
async function submitted(db: Db, orgId: string) {
  const { session } = await startBriefSession(db, orgId);
  await patchBriefSession(db, orgId, session.id, {
    mutationId: crypto.randomUUID(), expectedRevision: 0, fields: COMPLETE,
  });
  await captureLeadFromDraft(db, orgId, session.id, { name: "Sam Taylor", phone: "07700900123" });
  const result = await submitBrief(db, orgId, session.id, { idempotencyKey: "press-key-one", expectedRevision: 1 });
  if (result.status !== "submitted") throw new Error("expected a submission");
  return result.submissionId;
}

class FailingWriter implements BriefWriterAdapter {
  readonly name = "openai" as const;
  readonly live = true;
  async write(): Promise<WrittenBrief> {
    throw new Error("429 rate limit exceeded");
  }
}

describe("withoutContactDetails", () => {
  /**
   * The model is writing about a business, not a person. A phone number in a
   * prompt is a phone number in somebody else's logs for no benefit.
   */
  it("holds back every contact field and keeps the rest", () => {
    const stripped = withoutContactDetails(COMPLETE);

    expect(stripped.name).toBeUndefined();
    expect(stripped.email).toBeUndefined();
    expect(stripped.phone).toBeUndefined();
    expect(stripped.addressLine1).toBeUndefined();
    expect(stripped.city).toBeUndefined();
    expect(stripped.postcode).toBeUndefined();
    expect(stripped.business).toBe("Taylor Plumbing");
    expect(stripped.goals).toEqual(["enquiries"]);
  });
});

describe("writeBriefVersion", () => {
  it("adds a written version alongside the plain one", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const submissionId = await submitted(db, org.id);

      const result = await writeBriefVersion(db, org.id, submissionId, new MockBriefWriter());

      expect(result).toEqual({ status: "written", version: 2 });
      const versions = await db.select().from(schema.briefVersions).where(eq(schema.briefVersions.submissionId, submissionId));
      expect(versions).toHaveLength(2);
      // Version one is untouched. It is the thing that is true no matter what.
      const first = versions.find((row) => row.version === 1)!;
      expect(first.generatorVersion).toBe("deterministic-1");
      expect(first.markdown).toContain("Taylor Plumbing");
    });
  });

  it("stores the structured brief, its schema version and the model", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const submissionId = await submitted(db, org.id);

      await writeBriefVersion(db, org.id, submissionId, new MockBriefWriter());

      const [written] = await db
        .select()
        .from(schema.briefVersions)
        .where(eq(schema.briefVersions.submissionId, submissionId))
        .orderBy(schema.briefVersions.version);
      const [, second] = await db
        .select()
        .from(schema.briefVersions)
        .where(eq(schema.briefVersions.submissionId, submissionId))
        .orderBy(schema.briefVersions.version);
      expect(written).toBeDefined();
      expect(second!.schemaVersion).toBe("1");
      expect(second!.model).toBe("mock");
      expect((second!.structured as Record<string, unknown>).projectTitle).toBe("Taylor Plumbing");
      // Never a quotation, whatever else it says.
      expect((second!.structured as { budgetAndTiming: { isQuote: boolean } }).budgetAndTiming.isQuote).toBe(false);
    });
  });

  /** A worker that ran twice must not produce two version twos. */
  it("does not write a second time", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const submissionId = await submitted(db, org.id);
      await writeBriefVersion(db, org.id, submissionId, new MockBriefWriter());

      const again = await writeBriefVersion(db, org.id, submissionId, new MockBriefWriter());

      expect(again).toEqual({ status: "skipped", reason: "already_written" });
      const versions = await db.select().from(schema.briefVersions).where(eq(schema.briefVersions.submissionId, submissionId));
      expect(versions).toHaveLength(2);
    });
  });

  /**
   * The point of the whole ordering: a provider failure costs a better
   * document and nothing else.
   */
  it("keeps the submission and the plain brief when the writer fails", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const submissionId = await submitted(db, org.id);

      const result = await writeBriefVersion(db, org.id, submissionId, new FailingWriter());

      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.reason).toContain("429");

      const [submission] = await db.select().from(schema.briefSubmissions).where(eq(schema.briefSubmissions.id, submissionId));
      expect(submission!.reference).toMatch(/^LF-/);
      const versions = await db.select().from(schema.briefVersions).where(eq(schema.briefVersions.submissionId, submissionId));
      expect(versions).toHaveLength(1);
      expect(versions[0]!.markdown).toContain("Taylor Plumbing");
    });
  });

  /**
   * Told once, when it gives up — not on every attempt. It used to ring on
   * every five-minute sweep, which was 109 bells in one day for one brief, and
   * every one of those attempts was a paid model call.
   */
  it("rings the owner's bell once, when it gives up, and not on the attempts before", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const submissionId = await submitted(db, org.id);
      const bells = async () => (await db.select().from(schema.notifications)
        .where(eq(schema.notifications.organisationId, org.id)))
        .filter((row) => row.kind === "brief.write_failed");

      const first = await writeBriefVersion(db, org.id, submissionId, new FailingWriter());
      expect(first).toMatchObject({ status: "failed", attempts: 1, gaveUp: false });
      expect(await bells()).toHaveLength(0);

      await writeBriefVersion(db, org.id, submissionId, new FailingWriter());
      const last = await writeBriefVersion(db, org.id, submissionId, new FailingWriter());

      expect(last).toMatchObject({ status: "failed", attempts: MAX_BRIEF_WRITE_ATTEMPTS, gaveUp: true });
      const rung = await bells();
      expect(rung).toHaveLength(1);
      expect(rung[0]!.body).toContain("429");
    });
  });

  it("records each attempt on the submission, so the reason survives the log", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const submissionId = await submitted(db, org.id);

      await writeBriefVersion(db, org.id, submissionId, new FailingWriter());

      const [submission] = await db.select().from(schema.briefSubmissions).where(eq(schema.briefSubmissions.id, submissionId));
      expect(submission!.metadata).toMatchObject({ briefWriteAttempts: 1, briefWriteLastError: "429 rate limit exceeded" });
      expect(submission!.metadata).not.toHaveProperty("briefWriteGaveUpAt");
    });
  });

  it("reports a submission it cannot find rather than throwing", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const result = await writeBriefVersion(db, org.id, crypto.randomUUID(), new MockBriefWriter());
      expect(result.status).toBe("failed");
    });
  });
});

describe("submissionsAwaitingBrief", () => {
  it("lists what still has only a plain brief, and stops once written", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const submissionId = await submitted(db, org.id);

      expect(await submissionsAwaitingBrief(db, org.id)).toHaveLength(1);

      await writeBriefVersion(db, org.id, submissionId, new MockBriefWriter());

      expect(await submissionsAwaitingBrief(db, org.id)).toHaveLength(0);
    });
  });

  /** A failed attempt leaves nothing claimed, so the next sweep picks it up. */
  it("still lists one whose writer failed", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const submissionId = await submitted(db, org.id);
      await writeBriefVersion(db, org.id, submissionId, new FailingWriter());

      expect(await submissionsAwaitingBrief(db, org.id)).toHaveLength(1);
    });
  });

  /** A writer that fails the same way three times is not going to come good on the fourth paid call. */
  it("stops offering one the writer has given up on", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const submissionId = await submitted(db, org.id);
      for (let i = 0; i < MAX_BRIEF_WRITE_ATTEMPTS; i += 1) {
        await writeBriefVersion(db, org.id, submissionId, new FailingWriter());
      }

      expect(await submissionsAwaitingBrief(db, org.id)).toHaveLength(0);
    });
  });
});
