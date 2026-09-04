import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { decideApproval } from "./decide-approval.js";

async function fixture(db: Db, opts: { withRun?: boolean } = {}) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `dec-${randomUUID()}` }).returning();
  const runId = opts.withRun
    ? (await db.insert(schema.agentRuns)
        .values({ organisationId: org!.id, agentKey: "support-triage", trigger: "manual", status: "awaiting_approval" })
        .returning())[0]!.id
    : null;
  const [approval] = await db.insert(schema.approvals).values({
    organisationId: org!.id,
    kind: "message_send",
    title: "Send something outward",
    payload: { action: "invoice_send", invoiceId: randomUUID() },
    ...(runId ? { runId } : {}),
  }).returning();
  return { orgId: org!.id, approval: approval! };
}

describe("decideApproval", () => {
  it("claims a run-less approval once and stamps the decision", async () => {
    await withTestDb(async (db) => {
      const { orgId, approval } = await fixture(db);

      const first = await decideApproval(db, orgId, {
        approvalId: approval.id, decision: "approved", decidedByUserId: "u1", note: "ok",
      });

      expect(first.alreadyDecided).toBe(false);
      if (first.alreadyDecided) throw new Error("unreachable");
      expect(first.after.status).toBe("approved");
      expect(first.after.decidedBy).toBe("u1");
      expect(first.after.decisionNote).toBe("ok");
      expect(first.after.decidedAt).toBeInstanceOf(Date);
    });
  });

  it("refuses a second decision, so approve-then-reject cannot act twice", async () => {
    await withTestDb(async (db) => {
      const { orgId, approval } = await fixture(db);
      await decideApproval(db, orgId, { approvalId: approval.id, decision: "approved", decidedByUserId: "u1" });

      const second = await decideApproval(db, orgId, {
        approvalId: approval.id, decision: "rejected", decidedByUserId: "u2",
      });

      expect(second.alreadyDecided).toBe(true);
      const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
      expect(row!.status).toBe("approved");
      expect(row!.decidedBy).toBe("u1");
    });
  });

  it("stamps an agent-backed approval here too, so the kernel never has to write the decision", async () => {
    await withTestDb(async (db) => {
      const { orgId, approval } = await fixture(db, { withRun: true });

      const first = await decideApproval(db, orgId, {
        approvalId: approval.id, decision: "approved", decidedByUserId: "u1", note: "send it",
      });
      expect(first.alreadyDecided).toBe(false);

      const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
      // The row is the authoritative record of the decision for a run-backed
      // approval as much as for a run-less one: `resumeAgent` reads status,
      // `decidedBy` and the note from here rather than from the job payload.
      // What says "not carried out yet" is the run's `metadata.pending`.
      expect(row!.status).toBe("approved");
      expect(row!.decidedBy).toBe("u1");
      expect(row!.decisionNote).toBe("send it");
      expect(row!.decidedAt).toBeInstanceOf(Date);

      const second = await decideApproval(db, orgId, {
        approvalId: approval.id, decision: "rejected", decidedByUserId: "u2",
      });
      expect(second.alreadyDecided).toBe(true);
      const [unchanged] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
      expect([unchanged!.status, unchanged!.decidedBy]).toEqual(["approved", "u1"]);
    });
  });

  it("treats an approval from another organisation as undecidable", async () => {
    await withTestDb(async (db) => {
      const { approval } = await fixture(db);
      const [other] = await db.insert(schema.organisations)
        .values({ name: "Other", slug: `dec-${randomUUID()}` }).returning();

      const result = await decideApproval(db, other!.id, {
        approvalId: approval.id, decision: "approved", decidedByUserId: "u1",
      });

      expect(result).toEqual({ alreadyDecided: true, approval: undefined });
      const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
      expect(row!.status).toBe("pending");
    });
  });
});
