import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createClient } from "../clients/create-client.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { createSite } from "../sites/create-site.js";
import { createTicket } from "../support/create-ticket.js";
import { seedOrgWithClient } from "./test-fixtures.js";
import { createTask } from "./create-task.js";
import { getTask } from "./get-task.js";

describe("createTask", () => {
  it("writes the task, audits it, records activity and emits task.created", async () => {
    await withTestDb(async (db) => {
      const events: DomainEvent[] = [];
      setEnqueue(async (e) => { events.push(e); });
      const { organisationId, clientId } = await seedOrgWithClient(db);

      const task = await createTask(db, organisationId, {
        clientId, title: "Build website", kind: "build", phase: "onboarding",
        dueAt: new Date("2026-10-15T09:00:00.000Z"), descriptionMd: "Ship the marketing site",
        checklist: [{ label: "Homepage" }, { label: "Contact form" }],
        actorKind: "user", actorId: "user-1",
      });

      expect(task.status).toBe("todo");
      expect(task.priority).toBe("medium");
      expect(task.clientVisible).toBe(true);
      expect(task.checklist).toEqual([{ label: "Homepage", done: false }, { label: "Contact form", done: false }]);
      expect(task.createdByKind).toBe("user");

      const loaded = await getTask(db, organisationId, task.id);
      expect(loaded?.task.title).toBe("Build website");
      expect(loaded?.comments).toEqual([]);

      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, task.id));
      expect(audits.map((a) => a.action)).toEqual(["task.created"]);
      expect(events).toEqual([{ name: "task.created", organisationId, taskId: task.id }]);

      setEnqueue(async () => {});
    });
  });

  it("refuses a client from another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await expect(
        createTask(db, b.organisationId, { clientId: a.clientId, title: "X", kind: "other", phase: "support" }),
      ).rejects.toThrow(/not found in organisation/);
      expect(await getTask(db, b.organisationId, a.clientId)).toBeNull();
    });
  });

  it("refuses a ticket id from another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const { ticket } = await createTicket(db, a.organisationId, {
        clientId: a.clientId, subject: "A's ticket", body: "hello", source: "agent",
      });

      await expect(
        createTask(db, b.organisationId, {
          clientId: b.clientId, title: "Hijack ticket", kind: "other", phase: "support", ticketId: ticket.id,
        }),
      ).rejects.toThrow(/not found in organisation/);
    });
  });

  it("refuses a site that belongs to another client in the same organisation", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId: clientA } = await seedOrgWithClient(db);
      const siteA = await createSite(db, organisationId, { clientId: clientA, name: "A's site", primaryUrl: "https://a.test" });
      const clientB = await createClient(db, organisationId, { name: "Second Client" });

      await expect(
        createTask(db, organisationId, {
          clientId: clientB.id, title: "Wrong client's site", kind: "other", phase: "support", siteId: siteA.id,
        }),
      ).rejects.toThrow(`site ${siteA.id} belongs to another client`);
    });
  });

  it("refuses an assignee who is not an active member of the organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);

      await expect(
        createTask(db, a.organisationId, {
          clientId: a.clientId, title: "Assign to outsider", kind: "other", phase: "support", assigneeUserId: b.ownerUserId,
        }),
      ).rejects.toThrow(`user ${b.ownerUserId} is not an active member of this organisation`);
    });
  });
});
