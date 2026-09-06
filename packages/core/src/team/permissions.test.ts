import { describe, expect, it } from "vitest";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq } from "drizzle-orm";
import { addStaffMember, seedOrgWithClient } from "../tasks/test-fixtures.js";
import { listMembers } from "./list-members.js";
import {
  PermissionDenied,
  assertPermission,
  defaultPermissions,
  getMemberPermissions,
  hasPermission,
  resolvePermissions,
  setMemberPermissions,
} from "./permissions.js";

describe("permissions (pure)", () => {
  it("owner defaults to everything; staff to everything except settings", () => {
    expect(defaultPermissions("owner")).toEqual({ support: true, content: true, billing: true, settings: true, approvals: true, access: true });
    expect(defaultPermissions("staff")).toEqual({ support: true, content: true, billing: true, settings: false, approvals: true, access: true });
  });

  it("an owner resolves to all six whatever is stored; staff overlay only the keys that are booleans", () => {
    expect(resolvePermissions("owner", { support: false, settings: false, access: false })).toEqual(defaultPermissions("owner"));
    expect(resolvePermissions("staff", null)).toEqual(defaultPermissions("staff"));
    expect(resolvePermissions("staff", { billing: false, settings: true, access: false })).toEqual({
      support: true, content: true, billing: false, settings: true, approvals: true, access: false,
    });
    // A stored value that is not a boolean (a corrupt column) reads as the default.
    expect(resolvePermissions("staff", { support: "no" as unknown as boolean })).toEqual(defaultPermissions("staff"));
  });
});

describe("permissions (db)", () => {
  it("reads defaults, stores a narrowed set for staff, audits it, and lists it", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const staffUserId = await addStaffMember(db, organisationId);

      const before = await getMemberPermissions(db, organisationId, { userId: staffUserId });
      expect(before?.permissions).toEqual(defaultPermissions("staff"));
      expect(before?.stored).toBeNull();

      const staff = (await listMembers(db, organisationId)).find((m) => m.userId === staffUserId)!;
      const after = await setMemberPermissions(db, organisationId, {
        memberId: staff.id, permissions: { billing: false, settings: true }, actorId: ownerUserId,
      });
      expect(after.permissions).toEqual({ support: true, content: true, billing: false, settings: true, approvals: true, access: true });

      const reread = await getMemberPermissions(db, organisationId, { userId: staffUserId });
      expect(reread?.permissions).toEqual(after.permissions);
      // The whole resolved set is stored, so a later default change cannot silently widen it.
      expect(reread?.stored).toEqual(after.permissions);

      const listed = (await listMembers(db, organisationId)).find((m) => m.userId === staffUserId)!;
      expect(listed.permissions).toEqual(after.permissions);
      const owner = (await listMembers(db, organisationId)).find((m) => m.userId === ownerUserId)!;
      expect(owner.permissions).toEqual(defaultPermissions("owner"));

      const audits = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.action, "member.permissions_updated")));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actorId).toBe(ownerUserId);
      expect(audits[0]!.targetId).toBe(staff.id);
      expect((audits[0]!.before as { billing: boolean }).billing).toBe(true);
      expect((audits[0]!.after as { billing: boolean }).billing).toBe(false);
    });
  });

  it("refuses to narrow an owner and refuses a member of another organisation", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const owner = (await listMembers(db, a.organisationId)).find((m) => m.userId === a.ownerUserId)!;
      await expect(setMemberPermissions(db, a.organisationId, { memberId: owner.id, permissions: { settings: false }, actorId: a.ownerUserId }))
        .rejects.toThrow(/owner always has every permission/);

      const staffB = await addStaffMember(db, b.organisationId);
      const memberB = (await listMembers(db, b.organisationId)).find((m) => m.userId === staffB)!;
      await expect(setMemberPermissions(db, a.organisationId, { memberId: memberB.id, permissions: { support: false }, actorId: a.ownerUserId }))
        .rejects.toThrow(/not found in organisation/);
      expect(await getMemberPermissions(db, a.organisationId, { userId: staffB })).toBeNull();
    });
  });

  it("assertPermission passes the owner, refuses a staff member without settings, and refuses strangers and suspended members", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const staffUserId = await addStaffMember(db, organisationId);

      await expect(assertPermission(db, organisationId, ownerUserId, "settings")).resolves.toEqual(defaultPermissions("owner"));
      await expect(assertPermission(db, organisationId, staffUserId, "support")).resolves.toMatchObject({ support: true });
      await expect(assertPermission(db, organisationId, staffUserId, "settings")).rejects.toBeInstanceOf(PermissionDenied);
      await expect(assertPermission(db, organisationId, staffUserId, "settings")).rejects.toMatchObject({ key: "settings" });
      expect(await hasPermission(db, organisationId, staffUserId, "settings")).toBe(false);
      expect(await hasPermission(db, organisationId, staffUserId, "approvals")).toBe(true);

      await expect(assertPermission(db, organisationId, "nobody", "support")).rejects.toThrow(/not an active member/);
      expect(await hasPermission(db, organisationId, "nobody", "support")).toBe(false);

      await db.update(schema.organisationMembers).set({ status: "suspended" })
        .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.userId, staffUserId)));
      await expect(assertPermission(db, organisationId, staffUserId, "support")).rejects.toThrow(/not an active member/);
    });
  });
});
