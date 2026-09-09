import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { ApprovalNotDeletable, deleteApproval, deleteRejectedApprovals } from "./delete-approval.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

async function approval(db: Db, organisationId: string, status: "pending" | "approved" | "rejected") {
  const [row] = await db
    .insert(schema.approvals)
    .values({ organisationId, kind: "message_send", title: `Send something (${status})`, status })
    .returning();
  return row!;
}

const remaining = (db: Db, organisationId: string) =>
  db.select().from(schema.approvals).where(eq(schema.approvals.organisationId, organisationId));

describe("deleteApproval", () => {
  it("clears a rejected card and records that it was cleared", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const card = await approval(db, org.id, "rejected");

      await deleteApproval(db, org.id, { approvalId: card.id, actorId: "u1" });

      expect(await remaining(db, org.id)).toHaveLength(0);
      const [audit] = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, org.id), eq(schema.auditLog.action, "approval.deleted")));
      expect(audit!.targetId).toBe(card.id);
    });
  });

  // The guard. A pending card is still somebody's decision to make.
  it("refuses a pending card, and says to reject it first", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const card = await approval(db, org.id, "pending");

      await expect(deleteApproval(db, org.id, { approvalId: card.id, actorId: "u1" }))
        .rejects.toThrow(ApprovalNotDeletable);
      expect(await remaining(db, org.id)).toHaveLength(1);
    });
  });

  /** An approved card is the record of what an agent was allowed to do. */
  it("refuses an approved card, because it is the record of a decision that had an effect", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const card = await approval(db, org.id, "approved");

      await expect(deleteApproval(db, org.id, { approvalId: card.id, actorId: "u1" }))
        .rejects.toThrow(/kept/);
      expect(await remaining(db, org.id)).toHaveLength(1);
    });
  });

  it("will not reach another organisation's card", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      const card = await approval(db, theirs.id, "rejected");

      await expect(deleteApproval(db, mine.id, { approvalId: card.id, actorId: "u1" }))
        .rejects.toThrow(/could not be found/);
      expect(await remaining(db, theirs.id)).toHaveLength(1);
    });
  });
});

describe("deleteRejectedApprovals", () => {
  it("clears every rejected card and leaves pending and approved alone", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await approval(db, org.id, "rejected");
      await approval(db, org.id, "rejected");
      const pending = await approval(db, org.id, "pending");
      const approved = await approval(db, org.id, "approved");

      expect(await deleteRejectedApprovals(db, org.id, "u1")).toEqual({ deleted: 2 });

      const left = await remaining(db, org.id);
      expect(left.map((row) => row.id).sort()).toEqual([pending.id, approved.id].sort());
    });
  });

  it("writes one audit row for the sweep, not one per card", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await approval(db, org.id, "rejected");
      await approval(db, org.id, "rejected");
      await approval(db, org.id, "rejected");

      await deleteRejectedApprovals(db, org.id, "u1");

      const audits = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, org.id), eq(schema.auditLog.action, "approval.rejected_cleared")));
      expect(audits).toHaveLength(1);
      expect((audits[0]!.before as { count: number }).count).toBe(3);
    });
  });

  it("does nothing, and says so, when there is nothing rejected", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await approval(db, org.id, "pending");

      expect(await deleteRejectedApprovals(db, org.id, "u1")).toEqual({ deleted: 0 });
      const audits = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, org.id), eq(schema.auditLog.action, "approval.rejected_cleared")));
      expect(audits).toHaveLength(0);
    });
  });

  it("never sweeps another organisation's rejections", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      await approval(db, theirs.id, "rejected");

      expect(await deleteRejectedApprovals(db, mine.id, "u1")).toEqual({ deleted: 0 });
      expect(await remaining(db, theirs.id)).toHaveLength(1);
    });
  });
});
