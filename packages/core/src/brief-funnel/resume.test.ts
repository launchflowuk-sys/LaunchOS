import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { captureLeadFromDraft } from "./capture.js";
import { draftForEmail, exchangeResumeToken, issueResumeToken } from "./resume.js";
import { briefSessionBySecret, hashSecret, patchBriefSession, startBriefSession } from "./sessions.js";
import { submitBrief } from "./submit.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

/** A draft with a contactable lead behind it. */
async function draftFor(db: Db, orgId: string, email = "sam@taylorplumbing.co.uk") {
  const { session, secret } = await startBriefSession(db, orgId);
  await patchBriefSession(db, orgId, session.id, {
    mutationId: crypto.randomUUID(), expectedRevision: 0,
    fields: { name: "Sam Taylor", email, business: "Taylor Plumbing" },
  });
  await captureLeadFromDraft(db, orgId, session.id, { name: "Sam Taylor", email });
  return { sessionId: session.id, originalSecret: secret };
}

describe("draftForEmail", () => {
  it("finds a draft by the address on its lead", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { sessionId } = await draftFor(db, org.id);

      const found = await draftForEmail(db, org.id, "sam@taylorplumbing.co.uk");

      expect(found?.sessionId).toBe(sessionId);
    });
  });

  it("does not care about case or stray spaces", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await draftFor(db, org.id);

      expect(await draftForEmail(db, org.id, "  SAM@TaylorPlumbing.co.uk ")).not.toBeNull();
    });
  });

  it("finds nothing for an address with no draft", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await draftFor(db, org.id);

      expect(await draftForEmail(db, org.id, "nobody@example.com")).toBeNull();
      expect(await draftForEmail(db, org.id, "")).toBeNull();
    });
  });

  /** Somebody who already sent their brief has nothing to come back to. */
  it("finds nothing once the brief has been sent", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { sessionId } = await draftFor(db, org.id);
      await db.update(schema.briefSessions).set({ status: "submitted" }).where(eq(schema.briefSessions.id, sessionId));

      expect(await draftForEmail(db, org.id, "sam@taylorplumbing.co.uk")).toBeNull();
    });
  });

  it("does not reach across organisations", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      await draftFor(db, mine.id);

      expect(await draftForEmail(db, theirs.id, "sam@taylorplumbing.co.uk")).toBeNull();
    });
  });
});

describe("issueResumeToken", () => {
  it("stores only the hash, never the token", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { sessionId } = await draftFor(db, org.id);

      const { token } = await issueResumeToken(db, org.id, sessionId);

      const [row] = await db.select().from(schema.briefResumeTokens).where(eq(schema.briefResumeTokens.sessionId, sessionId));
      expect(row!.tokenHash).toBe(hashSecret(token));
      expect(row!.tokenHash).not.toBe(token);
    });
  });

  /**
   * Two live links for one draft means the older mail still works after the
   * newer one is used — exactly what one-time is meant to prevent.
   */
  it("revokes any link already outstanding", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { sessionId } = await draftFor(db, org.id);
      const first = await issueResumeToken(db, org.id, sessionId);

      await issueResumeToken(db, org.id, sessionId);

      expect((await exchangeResumeToken(db, org.id, first.token)).ok).toBe(false);
    });
  });
});

describe("exchangeResumeToken", () => {
  it("opens the draft and rotates the cookie secret", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { sessionId, originalSecret } = await draftFor(db, org.id);
      const { token } = await issueResumeToken(db, org.id, sessionId);

      const result = await exchangeResumeToken(db, org.id, token);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.sessionId).toBe(sessionId);
      // The new secret works.
      expect((await briefSessionBySecret(db, org.id, result.secret))?.id).toBe(sessionId);
      // The old one does not: a resume link is used because the old browser is
      // gone, and leaving it working keeps an abandoned device in the draft.
      expect(await briefSessionBySecret(db, org.id, originalSecret)).toBeNull();
    });
  });

  /** A mailbox is not a secret store. A link that works twice works for the thread. */
  it("refuses a token that has already been used", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { sessionId } = await draftFor(db, org.id);
      const { token } = await issueResumeToken(db, org.id, sessionId);
      await exchangeResumeToken(db, org.id, token);

      expect((await exchangeResumeToken(db, org.id, token)).ok).toBe(false);
    });
  });

  it("refuses an expired token", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { sessionId } = await draftFor(db, org.id);
      const { token } = await issueResumeToken(db, org.id, sessionId);
      await db
        .update(schema.briefResumeTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.briefResumeTokens.sessionId, sessionId));

      expect((await exchangeResumeToken(db, org.id, token)).ok).toBe(false);
    });
  });

  /** Unknown, spent, revoked and expired must be indistinguishable. */
  it("refuses a token nobody issued", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      expect((await exchangeResumeToken(db, org.id, "a".repeat(64))).ok).toBe(false);
      expect((await exchangeResumeToken(db, org.id, "")).ok).toBe(false);
    });
  });

  it("refuses once the brief has been sent", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { sessionId } = await draftFor(db, org.id);
      const { token } = await issueResumeToken(db, org.id, sessionId);
      await patchBriefSession(db, org.id, sessionId, {
        mutationId: crypto.randomUUID(), expectedRevision: 1,
        fields: {
          industry: "Plumbing", goals: ["enquiries"], designDirection: "clean",
          pages: ["home"], budget: "1500_3000", timeline: ["asap"],
        },
      });
      await submitBrief(db, org.id, sessionId, { idempotencyKey: "press-key-one", expectedRevision: 2 });

      expect((await exchangeResumeToken(db, org.id, token)).ok).toBe(false);
    });
  });

  it("does not reach across organisations", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      const { sessionId } = await draftFor(db, mine.id);
      const { token } = await issueResumeToken(db, mine.id, sessionId);

      expect((await exchangeResumeToken(db, theirs.id, token)).ok).toBe(false);
    });
  });
});
