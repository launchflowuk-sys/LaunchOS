import { beforeEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { createMember } from "./create-member.js";
import { listMembers } from "./list-members.js";
import { markInitialPasswordSet } from "./mark-initial-password-set.js";
import { reissueOneTimePassword } from "./reissue-password.js";

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

describe("markInitialPasswordSet", () => {
  const events: DomainEvent[] = [];
  beforeEach(() => {
    events.length = 0;
    setEnqueue(async (e) => {
      events.push(e);
    });
  });

  it("stamps the membership, audits it, and closes the re-issue window", async () => {
    await withTestDb(async (db) => {
      const { org, ownerUserId } = await makeOrgWithOwner(db);
      const { member } = await createMember(db, org.id, {
        email: `staff-${crypto.randomUUID()}@example.test`,
        displayName: "Sam Staff",
        role: "staff",
        invitedBy: ownerUserId,
      });
      expect(member.initialPasswordSetAt).toBeNull();

      const stamped = await markInitialPasswordSet(db, org.id, { userId: member.userId });

      expect(stamped?.id).toBe(member.id);
      expect(stamped?.initialPasswordSetAt).toBeInstanceOf(Date);
      expect((await listMembers(db, org.id)).find((r) => r.id === member.id)?.initialPasswordSetAt).toBeInstanceOf(Date);

      const [entry] = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, org.id), eq(schema.auditLog.action, "member.initial_password_set")));
      expect(entry?.actorId).toBe(member.userId);
      expect(entry?.targetId).toBe(member.id);

      // The point of the stamp: the credential is now the member's own, so an
      // owner can no longer mint a replacement over the top of it.
      await expect(
        reissueOneTimePassword(db, org.id, { memberId: member.id, actor: ownerUserId }),
      ).rejects.toThrow("no re-issuable member with that id in this organisation");
    });
  });

  it("is idempotent: a second change keeps the first stamp and audits nothing", async () => {
    await withTestDb(async (db) => {
      const { org } = await makeOrgWithOwner(db);
      const { member } = await createMember(db, org.id, {
        email: `staff-${crypto.randomUUID()}@example.test`,
        displayName: "Sam Staff",
        role: "staff",
      });

      const first = await markInitialPasswordSet(db, org.id, { userId: member.userId });
      const second = await markInitialPasswordSet(db, org.id, { userId: member.userId });

      expect(second).toBeNull();
      const [row] = await db
        .select()
        .from(schema.organisationMembers)
        .where(eq(schema.organisationMembers.id, member.id));
      expect(row!.initialPasswordSetAt?.toISOString()).toBe(first!.initialPasswordSetAt?.toISOString());

      const entries = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, org.id), eq(schema.auditLog.action, "member.initial_password_set")));
      expect(entries).toHaveLength(1);
    });
  });

  it("stamps only the membership in the organisation asked for", async () => {
    await withTestDb(async (db) => {
      const { org: orgA } = await makeOrgWithOwner(db);
      const { org: orgB } = await makeOrgWithOwner(db);
      const { member } = await createMember(db, orgA.id, {
        email: `staff-${crypto.randomUUID()}@example.test`,
        displayName: "Sam Staff",
        role: "staff",
      });
      // The same Better Auth user, a member of a second organisation too.
      const [inB] = await db
        .insert(schema.organisationMembers)
        .values({ organisationId: orgB.id, userId: member.userId, role: "staff" })
        .returning();

      await markInitialPasswordSet(db, orgA.id, { userId: member.userId });

      const [rowB] = await db
        .select()
        .from(schema.organisationMembers)
        .where(eq(schema.organisationMembers.id, inB!.id));
      expect(rowB!.initialPasswordSetAt).toBeNull();
    });
  });

  it("returns null for a user who is not a member of this organisation", async () => {
    await withTestDb(async (db) => {
      const { org } = await makeOrgWithOwner(db);
      expect(await markInitialPasswordSet(db, org.id, { userId: crypto.randomUUID() })).toBeNull();
    });
  });
});
