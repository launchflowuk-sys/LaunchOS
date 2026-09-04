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
});
