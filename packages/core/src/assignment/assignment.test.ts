import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { createTaskTemplate } from "../packages/create-task-template.js";
import { createTicket } from "../support/create-ticket.js";
import { createTask } from "../tasks/create-task.js";
import { generateOnboardingTasks } from "../tasks/generate-onboarding-tasks.js";
import { addStaffMember, seedOrgWithClient } from "../tasks/test-fixtures.js";
import { setMemberPermissions } from "../team/permissions.js";
import { clockIn } from "../team/time-entries.js";
import { autoAssignTask, autoAssignTicket } from "./auto-assign.js";
import { pickAssignee } from "./pick-assignee.js";
import { getAssignmentRules, setAssignmentRules } from "./rules.js";

/**
 * `created_at` is frozen for the whole test transaction, so members seeded
 * together tie on it and the id tiebreak is random. Spacing them out makes
 * the membership order — and so every pick below — deterministic.
 */
async function staffInOrder(db: Db, organisationId: string, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, name] of names.entries()) {
    const userId = await addStaffMember(db, organisationId, name);
    await db.update(schema.organisationMembers)
      .set({ createdAt: new Date(Date.now() + (i + 1) * 60_000) })
      .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.userId, userId)));
    ids.push(userId);
  }
  return ids;
}

async function openTicket(db: Db, organisationId: string, clientId: string, assignedUserId: string) {
  const { ticket } = await createTicket(db, organisationId, { clientId, subject: "S", body: "B", source: "manual" });
  await db.update(schema.tickets).set({ assignedUserId }).where(eq(schema.tickets.id, ticket.id));
}

describe("assignment rules", () => {
  it("defaults to off, merges on save, audits, and leaves other metadata alone", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      await db.update(schema.organisations).set({ metadata: { firstResponseHours: 2 } }).where(eq(schema.organisations.id, organisationId));
      expect(await getAssignmentRules(db, organisationId)).toEqual({ support: "off", tasks: "off" });

      await setAssignmentRules(db, organisationId, { rules: { support: "least_open" }, actorId: ownerUserId });
      const after = await setAssignmentRules(db, organisationId, { rules: { tasks: "by_role_least_open" }, actorId: ownerUserId });
      expect(after).toEqual({ support: "least_open", tasks: "by_role_least_open" });
      const [org] = await db.select().from(schema.organisations).where(eq(schema.organisations.id, organisationId));
      expect(org!.metadata["firstResponseHours"]).toBe(2);
      const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.action, "organisation.assignment_updated")));
      expect(audits).toHaveLength(2);
    });
  });
});

describe("pickAssignee", () => {
  it("returns null with the rule off and the owner when nobody else is eligible", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      expect(await pickAssignee(db, organisationId, { area: "support" })).toBeNull();
      expect(await pickAssignee(db, organisationId, { area: "support", rules: { support: "least_open", tasks: "off" } })).toBe(ownerUserId);
      // A `staff` template with no staff member falls back to the owner too.
      expect(await pickAssignee(db, organisationId, { area: "tasks", role: "staff", rules: { support: "off", tasks: "by_role_least_open" } })).toBe(ownerUserId);
    });
  });

  it("least_open prefers the member with the fewest open cases, staff before owner on a tie", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      const [a, b] = (await staffInOrder(db, organisationId, ["A", "B"])) as [string, string];
      const rules = { support: "least_open" as const, tasks: "off" as const };
      expect(await pickAssignee(db, organisationId, { area: "support", rules })).toBe(a);
      await openTicket(db, organisationId, clientId, a);
      expect(await pickAssignee(db, organisationId, { area: "support", rules })).toBe(b);
      await openTicket(db, organisationId, clientId, b);
      // The owner wins only when strictly less loaded — and is now the only one on zero.
      expect(await pickAssignee(db, organisationId, { area: "support", rules })).toBe(ownerUserId);
      await openTicket(db, organisationId, clientId, ownerUserId);
      // All on one: staff before the owner, earliest membership first.
      expect(await pickAssignee(db, organisationId, { area: "support", rules })).toBe(a);
      await openTicket(db, organisationId, clientId, a);
      expect(await pickAssignee(db, organisationId, { area: "support", rules })).toBe(b);
    });
  });

  it("skips members without the support permission and, when asked, those not clocked in", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const [a, b] = (await staffInOrder(db, organisationId, ["A", "B"])) as [string, string];
      const [memberA] = await db.select().from(schema.organisationMembers).where(eq(schema.organisationMembers.userId, a));
      await setMemberPermissions(db, organisationId, { memberId: memberA!.id, permissions: { support: false }, actorId: ownerUserId });
      expect(await pickAssignee(db, organisationId, { area: "support", rules: { support: "least_open", tasks: "off" } })).toBe(b);

      const clocked = { support: "clocked_in_least_open" as const, tasks: "off" as const };
      // Nobody clocked in: everybody eligible is considered.
      expect(await pickAssignee(db, organisationId, { area: "support", rules: clocked })).toBe(b);
      await clockIn(db, organisationId, { userId: ownerUserId });
      expect(await pickAssignee(db, organisationId, { area: "support", rules: clocked })).toBe(ownerUserId);
    });
  });

  it("round robin walks the members in turn once the cursor advances", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      const [a, b] = (await staffInOrder(db, organisationId, ["A", "B"])) as [string, string];
      await setAssignmentRules(db, organisationId, { rules: { support: "round_robin" }, actorId: ownerUserId });
      const order: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const { ticket } = await createTicket(db, organisationId, { clientId, subject: `Case ${i}`, body: "B", source: "portal", actorKind: "client" });
        order.push(ticket.assignedUserId!);
      }
      expect(order).toEqual([ownerUserId, a, b, ownerUserId]);
    });
  });

  it("tasks: narrows by role and needs the content permission for content kinds", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const a = await addStaffMember(db, organisationId, "A");
      const [memberA] = await db.select().from(schema.organisationMembers).where(eq(schema.organisationMembers.userId, a));
      await setMemberPermissions(db, organisationId, { memberId: memberA!.id, permissions: { content: false }, actorId: ownerUserId });
      const rules = { support: "off" as const, tasks: "by_role_least_open" as const };
      expect(await pickAssignee(db, organisationId, { area: "tasks", role: "staff", taskKind: "build", rules })).toBe(a);
      expect(await pickAssignee(db, organisationId, { area: "tasks", role: "any", taskKind: "social", rules })).toBe(ownerUserId);
      expect(await pickAssignee(db, organisationId, { area: "tasks", role: "owner", taskKind: "build", rules })).toBe(ownerUserId);
    });
  });
});

describe("auto-assignment hooks", () => {
  it("createTicket leaves a case unassigned with the rule off and routes it with the rule on, notifying the assignee", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      const staff = await addStaffMember(db, organisationId, "Staff");
      const off = await createTicket(db, organisationId, { clientId, subject: "Off", body: "B", source: "portal", actorKind: "client" });
      expect(off.ticket.assignedUserId).toBeNull();

      await setAssignmentRules(db, organisationId, { rules: { support: "least_open" }, actorId: ownerUserId });
      const on = await createTicket(db, organisationId, { clientId, subject: "On", body: "B", source: "portal", actorKind: "client" });
      expect(on.ticket.assignedUserId).toBe(staff);
      const [stored] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, on.ticket.id));
      expect(stored!.assignedUserId).toBe(staff);

      const events = await db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, on.ticket.id));
      expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["created", "assigned"]));
      const [bell] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, staff), eq(schema.notifications.kind, "ticket.assigned")));
      expect(bell?.link).toBe(`/cases/${on.ticket.id}`);
      const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.action, "ticket.assigned")));
      expect(audits).toHaveLength(1);

      // Already assigned: nothing to do.
      expect(await autoAssignTicket(db, organisationId, { ticketId: on.ticket.id })).toBeNull();
    });
  });

  it("task generation routes by the template role with the rule on and keeps template defaults with it off", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      const staff = await addStaffMember(db, organisationId, "Staff");
      await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "build", title: "Build", defaultAssigneeRole: "owner" });
      await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "seo", title: "SEO", defaultAssigneeRole: "any" });

      const off = await generateOnboardingTasks(db, organisationId, clientId);
      expect(off.created.map((t) => [t.title, t.assigneeUserId])).toEqual(expect.arrayContaining([["Build", ownerUserId], ["SEO", null]]));

      const other = await seedOrgWithClient(db);
      await setAssignmentRules(db, other.organisationId, { rules: { tasks: "by_role_least_open" }, actorId: other.ownerUserId });
      await setAssignmentRules(db, organisationId, { rules: { tasks: "by_role_least_open" }, actorId: ownerUserId });
      await createTaskTemplate(db, organisationId, { phase: "onboarding", kind: "dns", title: "DNS", defaultAssigneeRole: "any" });
      const on = await generateOnboardingTasks(db, organisationId, clientId);
      expect(on.created).toHaveLength(1);
      const [dns] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, on.created[0]!.id));
      // Staff before owner on a tie, and the owner already holds "Build".
      expect(dns!.assigneeUserId).toBe(staff);
      const [bell] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, staff), eq(schema.notifications.kind, "task.assigned")));
      expect(bell).toBeDefined();

      const manual = await createTask(db, organisationId, { clientId, title: "Manual", phase: "support" });
      expect(await autoAssignTask(db, organisationId, { taskId: manual.id })).toEqual({ assignedUserId: staff });
      expect(await autoAssignTask(db, organisationId, { taskId: manual.id })).toBeNull();
      await expect(autoAssignTask(db, other.organisationId, { taskId: manual.id })).rejects.toThrow(/not found in organisation/);
    });
  });
});
