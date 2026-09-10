import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { captureLeadFromDraft } from "./capture.js";
import {
  briefSessionBySecret, completeBriefStep, expireStaleSessions, hashSecret,
  patchBriefSession, RevisionConflict, safeSource, startBriefSession,
} from "./sessions.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

const mutation = () => crypto.randomUUID();

describe("startBriefSession", () => {
  it("opens an anonymous draft and hands back a secret that is not stored", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const { session, secret } = await startBriefSession(db, org.id);

      expect(session.revision).toBe(0);
      expect(session.currentStep).toBe(1);
      expect(session.leadCaptured).toBe(false);
      const [row] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, session.id));
      expect(row!.sessionSecretHash).toBe(hashSecret(secret));
      expect(row!.sessionSecretHash).not.toBe(secret);
    });
  });

  it("keeps only known source fields, truncated", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id, {
        source: { utm_source: "google", utm_content: "x".repeat(500), email: "sam@example.com", junk: "<script>" },
      });

      const [row] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, session.id));
      expect(row!.source.utm_source).toBe("google");
      expect(row!.source.utm_content).toHaveLength(200);
      // Contact details and arbitrary keys must never reach source metadata.
      expect(row!.source.email).toBeUndefined();
      expect(row!.source.junk).toBeUndefined();
    });
  });
});

describe("briefSessionBySecret", () => {
  it("finds the draft behind a secret", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session, secret } = await startBriefSession(db, org.id);

      const found = await briefSessionBySecret(db, org.id, secret);

      expect(found?.id).toBe(session.id);
    });
  });

  /** Wrong secret, missing draft and expired draft all answer the same way. */
  it("gives nothing away for a wrong secret", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await startBriefSession(db, org.id);

      expect(await briefSessionBySecret(db, org.id, "not-a-real-secret")).toBeNull();
      expect(await briefSessionBySecret(db, org.id, "")).toBeNull();
    });
  });

  it("refuses an expired draft", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session, secret } = await startBriefSession(db, org.id);
      await db
        .update(schema.briefSessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.briefSessions.id, session.id));

      expect(await briefSessionBySecret(db, org.id, secret)).toBeNull();
    });
  });

  /**
   * One browser could only ever submit once. The cookie outlives the brief, so
   * the next person on the same computer resumed a stranger's answers and had
   * no way to start their own.
   */
  it("refuses a draft that has already been sent, so a fresh one is started", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session, secret } = await startBriefSession(db, org.id);
      await db.update(schema.briefSessions).set({ status: "submitted" }).where(eq(schema.briefSessions.id, session.id));

      expect(await briefSessionBySecret(db, org.id, secret)).toBeNull();
    });
  });

  it("refuses an expired draft the same way", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session, secret } = await startBriefSession(db, org.id);
      await db.update(schema.briefSessions).set({ status: "expired" }).where(eq(schema.briefSessions.id, session.id));

      expect(await briefSessionBySecret(db, org.id, secret)).toBeNull();
    });
  });

  it("does not reach across organisations", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      const { secret } = await startBriefSession(db, mine.id);

      expect(await briefSessionBySecret(db, theirs.id, secret)).toBeNull();
    });
  });
});

describe("patchBriefSession", () => {
  it("merges the patch and returns the committed revision", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);

      const first = await patchBriefSession(db, org.id, session.id, {
        mutationId: mutation(), expectedRevision: 0, fields: { name: "Sam Taylor" },
      });
      const second = await patchBriefSession(db, org.id, session.id, {
        mutationId: mutation(), expectedRevision: 1, fields: { phone: "07700900123" },
      });

      expect(first.revision).toBe(1);
      expect(second.revision).toBe(2);
      const [row] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, session.id));
      // The second write must not have taken the first one's answer with it.
      expect(row!.answers).toEqual({ name: "Sam Taylor", phone: "07700900123" });
    });
  });

  /**
   * What a phone on a bad connection does every time a request times out after
   * the server already committed it.
   */
  it("replays a repeated mutation id instead of applying it twice", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      const id = mutation();

      const first = await patchBriefSession(db, org.id, session.id, {
        mutationId: id, expectedRevision: 0, fields: { name: "Sam" },
      });
      const retry = await patchBriefSession(db, org.id, session.id, {
        mutationId: id, expectedRevision: 0, fields: { name: "Sam" },
      });

      expect(retry.revision).toBe(first.revision);
      expect(retry.replayed).toBe(true);
      const [row] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, session.id));
      expect(row!.revision).toBe(1);
    });
  });

  it("refuses a reused mutation id carrying a different change", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      const id = mutation();
      await patchBriefSession(db, org.id, session.id, { mutationId: id, expectedRevision: 0, fields: { name: "Sam" } });

      await expect(
        patchBriefSession(db, org.id, session.id, { mutationId: id, expectedRevision: 0, fields: { name: "Someone else" } }),
      ).rejects.toThrow(/already used/);
    });
  });

  /** Two tabs on one draft. Neither may silently win. */
  it("reports a conflict with the current revision rather than overwriting", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      await patchBriefSession(db, org.id, session.id, { mutationId: mutation(), expectedRevision: 0, fields: { name: "Sam" } });

      const stale = patchBriefSession(db, org.id, session.id, {
        mutationId: mutation(), expectedRevision: 0, fields: { name: "Stale tab" },
      });

      await expect(stale).rejects.toBeInstanceOf(RevisionConflict);
      const [row] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, session.id));
      expect(row!.answers).toEqual({ name: "Sam" });
    });
  });

  it("refuses to write to a brief that has been sent", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      await db.update(schema.briefSessions).set({ status: "submitted" }).where(eq(schema.briefSessions.id, session.id));

      await expect(
        patchBriefSession(db, org.id, session.id, { mutationId: mutation(), expectedRevision: 0, fields: { name: "Sam" } }),
      ).rejects.toThrow(/already been sent/);
    });
  });
});

describe("completeBriefStep", () => {
  it("records completion on the server and moves on", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);

      const after = await completeBriefStep(db, org.id, session.id, 1);

      expect(after.completedSteps).toEqual([1]);
      expect(after.currentStep).toBe(2);
    });
  });

  it("does not record a step twice when somebody goes back and forward", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      await completeBriefStep(db, org.id, session.id, 1);
      await completeBriefStep(db, org.id, session.id, 2);

      const again = await completeBriefStep(db, org.id, session.id, 1);

      expect(again.completedSteps).toEqual([1, 2]);
    });
  });

  it("does not run past the last step", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);

      const after = await completeBriefStep(db, org.id, session.id, 8);

      expect(after.currentStep).toBe(8);
    });
  });
});

describe("expireStaleSessions", () => {
  it("expires drafts nobody came back to, and leaves live ones alone", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const stale = await startBriefSession(db, org.id);
      const live = await startBriefSession(db, org.id);
      await db
        .update(schema.briefSessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.briefSessions.id, stale.session.id));

      expect(await expireStaleSessions(db, org.id)).toBe(1);

      const [staleRow] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, stale.session.id));
      const [liveRow] = await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.id, live.session.id));
      expect(staleRow!.status).toBe("expired");
      expect(liveRow!.status).toBe("draft");
    });
  });

  /** The lead is the valuable part, and it does not live here. */
  it("keeps the lead when the draft expires", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { session } = await startBriefSession(db, org.id);
      const { leadId } = await captureLeadFromDraft(db, org.id, session.id, { name: "Sam", phone: "07700900123" });
      await db
        .update(schema.briefSessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.briefSessions.id, session.id));

      await expireStaleSessions(db, org.id);

      const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.id, leadId!));
      expect(lead!.phone).toBe("07700900123");
    });
  });
});

describe("safeSource", () => {
  it("returns nothing for nothing", () => {
    expect(safeSource(undefined)).toEqual({});
    expect(safeSource({})).toEqual({});
  });
});
