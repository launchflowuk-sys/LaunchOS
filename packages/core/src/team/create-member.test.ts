import { beforeEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { verifyPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { createMember } from "./create-member.js";
import { deactivateMember } from "./deactivate-member.js";
import { reissueOneTimePassword } from "./reissue-password.js";
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
      // NULL until the member replaces the issued password with one of their
      // own — it is what keeps `reissueOneTimePassword` available to them.
      expect(member.initialPasswordSetAt).toBeNull();
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

  it("completes a pending invitation instead of refusing it as an existing member", async () => {
    await withTestDb(async (db) => {
      const { org, ownerUserId } = await makeOrgWithOwner(db);
      const email = `invited-${crypto.randomUUID()}@example.test`;
      const userId = crypto.randomUUID();
      // What `db:seed` writes for the demo staff member: a user and an
      // "invited" membership, but no credential, so they cannot sign in.
      await db.insert(schema.user).values({ id: userId, name: "Sam Staff", email, emailVerified: true });
      const [invited] = await db
        .insert(schema.organisationMembers)
        .values({ organisationId: org.id, userId, role: "staff", status: "invited", displayName: "Sam Staff" })
        .returning();

      const { member, oneTimePassword } = await createMember(db, org.id, {
        email, displayName: "Sam Staff", role: "staff", title: "Support", invitedBy: ownerUserId,
      });

      // The invitation is completed in place — no second membership row.
      expect(member.id).toBe(invited!.id);
      expect(member.userId).toBe(userId);
      expect(member.status).toBe("active");
      expect(member.title).toBe("Support");
      expect(member.initialPasswordSetAt).toBeNull();

      const [credential] = await db
        .select()
        .from(schema.account)
        .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "credential")));
      expect(await verifyPassword({ password: oneTimePassword, hash: credential!.password! })).toBe(true);

      const rows = await listMembers(db, org.id);
      expect(rows.filter((r) => r.email === email)).toHaveLength(1);

      // Completing it once is enough: the member is active with a credential now.
      await expect(createMember(db, org.id, { email, displayName: "Sam again", role: "staff" })).rejects.toThrow(
        `${email} is already a member of this organisation`,
      );
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

  it("refuses to consume another organisation's pending invitation", async () => {
    await withTestDb(async (db) => {
      const { org: orgA } = await makeOrgWithOwner(db);
      const { org: orgB } = await makeOrgWithOwner(db);
      const email = `invited-${crypto.randomUUID()}@example.test`;
      const userId = crypto.randomUUID();
      await db.insert(schema.user).values({ id: userId, name: "Sam Staff", email, emailVerified: true });
      await db
        .insert(schema.organisationMembers)
        .values({ organisationId: orgA.id, userId, role: "staff", status: "invited", displayName: "Sam Staff" });

      await expect(createMember(db, orgB.id, { email, displayName: "Sam from B", role: "staff" })).rejects.toThrow(
        "email already registered",
      );

      // No credential was minted for org A's user, so org A can still complete
      // the invitation it is waiting on.
      const credentials = await db
        .select()
        .from(schema.account)
        .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "credential")));
      expect(credentials).toHaveLength(0);

      const { member } = await createMember(db, orgA.id, { email, displayName: "Sam Staff", role: "staff" });
      expect(member.status).toBe("active");
    });
  });

  it("refuses to make a client-portal user a staff member", async () => {
    await withTestDb(async (db) => {
      const { org } = await makeOrgWithOwner(db);
      const [client] = await db
        .insert(schema.clients)
        .values({ organisationId: org.id, name: "Acme", slug: `acme-${crypto.randomUUID().slice(0, 8)}` })
        .returning();
      const email = `portal-${crypto.randomUUID()}@example.test`;
      const userId = crypto.randomUUID();
      // A portal user with no credential of their own: the asymmetric gap, since
      // `createClientUser` already refuses the mirror image.
      await db.insert(schema.user).values({ id: userId, name: "Portal User", email, emailVerified: true });
      await db.insert(schema.clientUsers).values({ organisationId: org.id, clientId: client!.id, userId });

      await expect(createMember(db, org.id, { email, displayName: "Portal User", role: "staff" })).rejects.toThrow(
        "client portal accounts cannot be staff members",
      );
      const members = await listMembers(db, org.id);
      expect(members.map((m) => m.email)).not.toContain(email);
    });
  });
});

describe("reissueOneTimePassword", () => {
  beforeEach(() => { setEnqueue(async () => {}); });

  it("issues a working replacement for a member still on the password they were given", async () => {
    await withTestDb(async (db) => {
      const { org, ownerUserId } = await makeOrgWithOwner(db);
      const email = `staff-${crypto.randomUUID()}@example.test`;
      const { member, oneTimePassword: first } = await createMember(db, org.id, {
        email, displayName: "Sam Staff", role: "staff", invitedBy: ownerUserId,
      });

      const { oneTimePassword: second } = await reissueOneTimePassword(db, org.id, {
        memberId: member.id, actor: ownerUserId,
      });
      expect(second).toHaveLength(16);
      expect(second).not.toBe(first);

      const [credential] = await db
        .select()
        .from(schema.account)
        .where(and(eq(schema.account.userId, member.userId), eq(schema.account.providerId, "credential")));
      expect(await verifyPassword({ password: second, hash: credential!.password! })).toBe(true);
      expect(await verifyPassword({ password: first, hash: credential!.password! })).toBe(false);

      const [audit] = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, org.id), eq(schema.auditLog.action, "member.password_reissued")));
      expect(audit!.targetId).toBe(member.id);
      expect(JSON.stringify(audit!.after)).not.toContain(second);
    });
  });

  it("refuses a member of another organisation, and one who has set their own password", async () => {
    await withTestDb(async (db) => {
      const { org: orgA } = await makeOrgWithOwner(db);
      const { org: orgB } = await makeOrgWithOwner(db);
      const { member } = await createMember(db, orgA.id, {
        email: `staff-${crypto.randomUUID()}@example.test`, displayName: "Sam", role: "staff",
      });

      await expect(reissueOneTimePassword(db, orgB.id, { memberId: member.id })).rejects.toThrow(
        "no re-issuable member with that id in this organisation",
      );

      await db
        .update(schema.organisationMembers)
        .set({ initialPasswordSetAt: new Date() })
        .where(eq(schema.organisationMembers.id, member.id));
      await expect(reissueOneTimePassword(db, orgA.id, { memberId: member.id })).rejects.toThrow(
        "no re-issuable member with that id in this organisation",
      );
    });
  });

  it("refuses when the underlying account is used outside this organisation", async () => {
    await withTestDb(async (db) => {
      const { org: orgA } = await makeOrgWithOwner(db);
      const { org: orgB } = await makeOrgWithOwner(db);
      const { member } = await createMember(db, orgA.id, {
        email: `staff-${crypto.randomUUID()}@example.test`, displayName: "Sam", role: "staff",
      });
      // One credential row backs both memberships, so org A must not be able to
      // rewrite it out from under org B.
      await db
        .insert(schema.organisationMembers)
        .values({ organisationId: orgB.id, userId: member.userId, role: "staff", displayName: "Sam" });

      await expect(reissueOneTimePassword(db, orgA.id, { memberId: member.id })).rejects.toThrow(
        "this account is used outside this organisation",
      );
    });
  });

  it("refuses a suspended member", async () => {
    await withTestDb(async (db) => {
      const { org, ownerUserId } = await makeOrgWithOwner(db);
      const { member } = await createMember(db, org.id, {
        email: `staff-${crypto.randomUUID()}@example.test`, displayName: "Sam", role: "staff",
      });
      await deactivateMember(db, org.id, { memberId: member.id, actorId: ownerUserId });
      await expect(reissueOneTimePassword(db, org.id, { memberId: member.id })).rejects.toThrow(
        "cannot re-issue a password for a suspended member",
      );
    });
  });
});
