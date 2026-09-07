import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { listApprovals } from "./list-approvals.js";

describe("listApprovals", () => {
  it("never returns the payload — the outward action itself is not list content", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      await db.insert(schema.approvals).values({
        organisationId,
        kind: "message_send",
        title: "Reply to Sarah about the invoice",
        // The body of a message to a client, and their address. An assistant
        // must not be handed either by a list endpoint.
        payload: { body: "Hi Sarah, the invoice is attached…", to: "sarah@example.test" },
      });

      const { approvals } = await listApprovals(db, organisationId);
      expect(approvals).toHaveLength(1);
      expect(JSON.stringify(approvals)).not.toContain("sarah@example.test");
      expect(JSON.stringify(approvals)).not.toContain("Hi Sarah");
      // What it *does* say is enough to know a decision is waiting.
      expect(approvals[0]!.title).toBe("Reply to Sarah about the invoice");
      expect(approvals[0]!.kind).toBe("message_send");
    });
  });

  it("says how long a pending approval has waited, and nothing once decided", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const [pending] = await db
        .insert(schema.approvals)
        .values({ organisationId, kind: "tool_call", title: "waiting" })
        .returning();
      await db
        .update(schema.approvals)
        .set({ createdAt: new Date(Date.now() - 5 * 3_600_000) })
        .where(eq(schema.approvals.id, pending!.id));

      await db.insert(schema.approvals).values({
        organisationId, kind: "tool_call", title: "done", status: "approved",
        decidedBy: ownerUserId, decidedAt: new Date(),
      });

      const { approvals } = await listApprovals(db, organisationId);
      const byTitle = Object.fromEntries(approvals.map((a) => [a.title, a]));
      expect(byTitle.waiting!.pendingHours).toBe(5);
      expect(byTitle.done!.pendingHours).toBeNull();
      expect(byTitle.done!.decidedAt).toBeInstanceOf(Date);
    });
  });

  it("filters by status and counts the whole match, not the page", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      for (let i = 0; i < 3; i += 1) {
        await db.insert(schema.approvals).values({ organisationId, kind: "tool_call", title: `pending ${i}` });
      }
      await db.insert(schema.approvals).values({ organisationId, kind: "tool_call", title: "approved", status: "approved" });

      const pending = await listApprovals(db, organisationId, { status: "pending", limit: 2 });
      expect(pending.approvals).toHaveLength(2);
      expect(pending.total).toBe(3);
      expect(pending.approvals.every((a) => a.status === "pending")).toBe(true);
    });
  });

  it("does not reshuffle between identical timestamps, so an offset page cannot skip a row", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      for (let i = 0; i < 4; i += 1) {
        await db.insert(schema.approvals).values({ organisationId, kind: "tool_call", title: `a${i}` });
      }
      const once = (await listApprovals(db, organisationId)).approvals.map((a) => a.id);
      const twice = (await listApprovals(db, organisationId)).approvals.map((a) => a.id);
      expect(once).toEqual(twice);
      // And the two pages together cover every row exactly once.
      const first = (await listApprovals(db, organisationId, { limit: 2, offset: 0 })).approvals.map((a) => a.id);
      const second = (await listApprovals(db, organisationId, { limit: 2, offset: 2 })).approvals.map((a) => a.id);
      expect(new Set([...first, ...second]).size).toBe(4);
    });
  });

  it("shows one organisation only its own", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await db.insert(schema.approvals).values({ organisationId: a.organisationId, kind: "tool_call", title: "A's" });

      expect((await listApprovals(db, a.organisationId)).total).toBe(1);
      expect((await listApprovals(db, b.organisationId)).total).toBe(0);
    });
  });
});
