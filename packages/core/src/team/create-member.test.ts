import { beforeEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { verifyPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { createMember } from "./create-member.js";
import { deactivateMember } from "./deactivate-member.js";
import { listMembers } from "./list-members.js";

async function makeOrgWithOwner(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const id = crypto.randomUUID();
  await db.insert(schema.user).values({ id, name: "Owner", email: `owner-${id}@example.test`, emailVerified: true });
  const [owner] = await db
    .insert(schema.organisationMembers)
    .values({ organisationId: org!.id, userId: id, role: "owner" })
    .returning();
  return { org: org!, ownerUserId: id, owner: owner! };
}

describe("createMember", () => {
  const events: DomainEvent[] = [];
  beforeEach(() => { events.length = 0; setEnqueue(async (e) => { events.push(e); }); });

  it("creates the account with a usable one-time password and lists the member", async () => {
    await withTestDb(async (db) => {
      const { org, ownerUserId } = await makeOrgWithOwner(db);
      const email = `staff-${crypto.randomUUID()}@example.test`;

      const { member, oneTimePassword } = await createMember(db, org.id, {
        email, displayName: "Sam Staff", role: "staff", title: "Support", invitedBy: ownerUserId,
      });
      expect(oneTimePassword).toHaveLength(16);
      expect(member.status).toBe("active");
      expect(member.initialPasswordSetAt).toBeInstanceOf(Date);
      expect(events).toEqual([{ name: "member.created", organisationId: org.id, memberId: member.id }]);

      const [credential] = await db
        .select()
        .from(schema.account)
        .where(and(eq(schema.account.userId, member.userId), eq(schema.account.providerId, "credential")));
      expect(credential!.issuer).toBe("local:credential");
      expect(await verifyPassword({ password: oneTimePassword, hash: credential!.password! })).toBe(true);

      const rows = await listMembers(db, org.id);
      expect(rows.map((r) => r.email)).toContain(email);
      expect(rows.find((r) => r.email === email)?.displayName).toBe("Sam Staff");

      const deactivated = await deactivateMember(db, org.id, { memberId: member.id, actorId: ownerUserId });
      expect(deactivated.status).toBe("suspended");
    });
  });

  it("refuses a second membership for the same email and refuses to remove the last owner", async () => {
    await withTestDb(async (db) => {
      const { org, owner } = await makeOrgWithOwner(db);
      const email = `staff-${crypto.randomUUID()}@example.test`;
      await createMember(db, org.id, { email, displayName: "Sam", role: "staff" });
      await expect(createMember(db, org.id, { email, displayName: "Sam again", role: "staff" })).rejects.toThrow(
        `${email} is already a member of this organisation`,
      );
      await expect(deactivateMember(db, org.id, { memberId: owner.id })).rejects.toThrow(
        "cannot deactivate the last active owner",
      );
    });
  });

  it("refuses to touch an existing credential across organisations instead of resetting it", async () => {
    await withTestDb(async (db) => {
      const { org: orgA } = await makeOrgWithOwner(db);
      const { org: orgB } = await makeOrgWithOwner(db);
      const email = `staff-${crypto.randomUUID()}@example.test`;

      const { member } = await createMember(db, orgA.id, { email, displayName: "Sam", role: "staff" });
      const [before] = await db
        .select()
        .from(schema.account)
        .where(and(eq(schema.account.userId, member.userId), eq(schema.account.providerId, "credential")));

      await expect(
        createMember(db, orgB.id, { email, displayName: "Sam from B", role: "staff" }),
      ).rejects.toThrow("email already registered");

      const [after] = await db
        .select()
        .from(schema.account)
        .where(and(eq(schema.account.userId, member.userId), eq(schema.account.providerId, "credential")));
      expect(after!.password).toBe(before!.password);

      const rowsInB = await listMembers(db, orgB.id);
      expect(rowsInB.map((r) => r.email)).not.toContain(email);
    });
  });

  it("creates a credential for an existing user who doesn't have one yet", async () => {
    await withTestDb(async (db) => {
      const { org } = await makeOrgWithOwner(db);
      const email = `portal-${crypto.randomUUID()}@example.test`;
      const userId = crypto.randomUUID();
      // Simulates a Better Auth user with no credential account yet, e.g. a
      // future passwordless client-portal user.
      await db.insert(schema.user).values({ id: userId, name: "Portal User", email, emailVerified: true });

      const { member, oneTimePassword } = await createMember(db, org.id, { email, displayName: "Portal User", role: "staff" });
      expect(member.userId).toBe(userId);

      const [credential] = await db
        .select()
        .from(schema.account)
        .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "credential")));
      expect(credential).toBeDefined();
      expect(await verifyPassword({ password: oneTimePassword, hash: credential!.password! })).toBe(true);
    });
  });
});
