import { beforeEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { createMember } from "./create-member.js";
import { listMembers } from "./list-members.js";
import { recordOwnPasswordChange } from "./record-own-password-change.js";
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

function auditRows(db: Db, organisationId: string, action: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.action, action)));
}

describe("recordOwnPasswordChange", () => {
  const events: DomainEvent[] = [];
  beforeEach(() => {
    events.length = 0;
    setEnqueue(async (e) => {
      events.push(e);
    });
  });

  it("audits the first change, stamps the membership, and closes the re-issue window", async () => {
    await withTestDb(async (db) => {
      const { org, ownerUserId } = await makeOrgWithOwner(db);
      const { member } = await createMember(db, org.id, {
        email: `staff-${crypto.randomUUID()}@example.test`,
        displayName: "Sam Staff",
        role: "staff",
        invitedBy: ownerUserId,
      });
      expect(member.initialPasswordSetAt).toBeNull();

      const result = await recordOwnPasswordChange(db, org.id, { userId: member.userId });

      expect(result?.stamped).toBe(true);
      expect(result?.member.id).toBe(member.id);
      expect(result?.member.initialPasswordSetAt).toBeInstanceOf(Date);
      expect((await listMembers(db, org.id)).find((r) => r.id === member.id)?.initialPasswordSetAt).toBeInstanceOf(Date);

      // The change itself is audited, and the audit carries membership rows
      // only — never the new password or its hash.
      const [changed] = await auditRows(db, org.id, "member.password_changed");
      expect(changed?.actorKind).toBe("user");
      expect(changed?.actorId).toBe(member.userId);
      expect(changed?.targetType).toBe("organisation_member");
      expect(changed?.targetId).toBe(member.id);
      expect(JSON.stringify(changed?.after)).not.toMatch(/hash|secret/i);

      // …and so is the one-way transition off the issued credential.
      const [stampEntry] = await auditRows(db, org.id, "member.initial_password_set");
      expect(stampEntry?.targetId).toBe(member.id);

      // The point of the stamp: the credential is now the member's own, so an
      // owner can no longer mint a replacement over the top of it.
      await expect(
        reissueOneTimePassword(db, org.id, { memberId: member.id, actor: ownerUserId }),
      ).rejects.toThrow("no re-issuable member with that id in this organisation");
    });
  });

  it("audits a second change too, and keeps the first stamp", async () => {
    await withTestDb(async (db) => {
      const { org } = await makeOrgWithOwner(db);
      const { member } = await createMember(db, org.id, {
        email: `staff-${crypto.randomUUID()}@example.test`,
        displayName: "Sam Staff",
        role: "staff",
      });

      const first = await recordOwnPasswordChange(db, org.id, { userId: member.userId });
      const second = await recordOwnPasswordChange(db, org.id, { userId: member.userId });

      // The stamp records one moment and does not move forward…
      expect(second?.stamped).toBe(false);
      const [row] = await db
        .select()
        .from(schema.organisationMembers)
        .where(eq(schema.organisationMembers.id, member.id));
      expect(row!.initialPasswordSetAt?.toISOString()).toBe(first!.member.initialPasswordSetAt?.toISOString());
      expect(await auditRows(db, org.id, "member.initial_password_set")).toHaveLength(1);

      // …but every change is on the record. This is the gap that mattered: the
      // second and every later change used to audit nothing at all.
      const changes = await auditRows(db, org.id, "member.password_changed");
      expect(changes).toHaveLength(2);
      expect(changes.every((r) => r.actorId === member.userId && r.targetId === member.id)).toBe(true);
    });
  });

  it("touches only the membership in the organisation asked for", async () => {
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

      await recordOwnPasswordChange(db, orgA.id, { userId: member.userId });

      const [rowB] = await db
        .select()
        .from(schema.organisationMembers)
        .where(eq(schema.organisationMembers.id, inB!.id));
      expect(rowB!.initialPasswordSetAt).toBeNull();
      expect(await auditRows(db, orgB.id, "member.password_changed")).toHaveLength(0);
    });
  });

  it("returns null, and audits nothing, for a user who is not a member of this organisation", async () => {
    await withTestDb(async (db) => {
      const { org } = await makeOrgWithOwner(db);
      expect(await recordOwnPasswordChange(db, org.id, { userId: crypto.randomUUID() })).toBeNull();
      expect(await auditRows(db, org.id, "member.password_changed")).toHaveLength(0);
    });
  });
});
