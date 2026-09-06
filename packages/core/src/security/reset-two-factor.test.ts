import { MockEmailAdapter } from "@launchos/channels";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resetTwoFactor, TwoFactorResetRefused } from "./reset-two-factor.js";

const PASSWORD = "a-long-enough-owner-password";
const env = { APP_URL: "https://os.launchflow.test", MAIL_FROM: "security@launchflow.test" } as NodeJS.ProcessEnv;

async function makeOrg(db: Db, requireStaffTwoFactor = false) {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: "T", slug: `t-${crypto.randomUUID()}`, requireStaffTwoFactor })
    .returning();
  return org!;
}

/** A `user` row, optionally already enrolled and optionally with a password. */
async function makeUser(db: Db, options: { enrolled?: boolean; password?: string } = {}) {
  const id = `u-${crypto.randomUUID()}`;
  await db
    .insert(schema.user)
    .values({ id, name: "Member", email: `${id}@example.com`, twoFactorEnabled: options.enrolled === true });
  if (options.enrolled) {
    await db.insert(schema.twoFactor).values({
      id: crypto.randomUUID(),
      // Stand-ins for the plugin's AES-256-GCM ciphertext; nothing here reads them.
      secret: "encrypted-seed",
      backupCodes: "encrypted-codes",
      userId: id,
    });
  }
  if (options.password) {
    await db.insert(schema.account).values({
      id: crypto.randomUUID(),
      accountId: id,
      providerId: "credential",
      issuer: "local:credential",
      userId: id,
      password: await hashPassword(options.password),
    });
  }
  return id;
}

async function makeMember(
  db: Db,
  organisationId: string,
  role: "owner" | "staff",
  options: { enrolled?: boolean; password?: string } = {},
) {
  const userId = await makeUser(db, options);
  await db.insert(schema.organisationMembers).values({ organisationId, userId, role });
  return userId;
}

async function makePortalUser(db: Db, organisationId: string, options: { enrolled?: boolean } = {}) {
  const [client] = await db
    .insert(schema.clients)
    .values({ organisationId, name: "Acme", slug: `acme-${crypto.randomUUID()}` })
    .returning();
  const userId = await makeUser(db, options);
  await db.insert(schema.clientUsers).values({ organisationId, clientId: client!.id, userId });
  return userId;
}

async function makeSession(db: Db, userId: string) {
  await db.insert(schema.session).values({
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    userId,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

async function enrolments(db: Db, userId: string) {
  return db.select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, userId));
}

async function auditRows(db: Db, organisationId: string) {
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.organisationId, organisationId));
}

describe("resetTwoFactor", () => {
  it("removes the enrolment, disables the flag and ends every session", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const owner = await makeMember(db, org.id, "owner", { password: PASSWORD });
      const staff = await makeMember(db, org.id, "staff", { enrolled: true });
      await makeSession(db, staff);
      await makeSession(db, staff);

      const result = await resetTwoFactor(
        db,
        org.id,
        { targetUserId: staff, actorId: owner, actorPassword: PASSWORD },
        {},
        env,
      );

      expect(result).toMatchObject({ kind: "member", enrolmentsRemoved: 1, sessionsEnded: 2 });
      expect(await enrolments(db, staff)).toHaveLength(0);
      const [row] = await db.select().from(schema.user).where(eq(schema.user.id, staff));
      expect(row!.twoFactorEnabled).toBe(false);
      const sessions = await db.select().from(schema.session).where(eq(schema.session.userId, staff));
      expect(sessions).toHaveLength(0);
    });
  });

  it("audits who reset whom, and carries no password or secret in the payload", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const owner = await makeMember(db, org.id, "owner", { password: PASSWORD });
      const staff = await makeMember(db, org.id, "staff", { enrolled: true });

      await resetTwoFactor(db, org.id, { targetUserId: staff, actorId: owner, actorPassword: PASSWORD }, {}, env);

      const rows = await auditRows(db, org.id);
      expect(rows.map((row) => row.action)).toEqual(["security.two_factor_reset"]);
      expect(rows[0]).toMatchObject({ actorKind: "user", actorId: owner, targetType: "user", targetId: staff });
      const payload = JSON.stringify(rows[0]!.after);
      expect(payload).toContain("resetBy");
      expect(payload).not.toContain(PASSWORD);
      expect(payload).not.toMatch(/secret|backupCode|encrypted-/i);
    });
  });

  it("emails the person whose factor was removed and rings the owner's bell", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const owner = await makeMember(db, org.id, "owner", { password: PASSWORD });
      const staff = await makeMember(db, org.id, "staff", { enrolled: true });
      const [target] = await db.select().from(schema.user).where(eq(schema.user.id, staff));
      const email = new MockEmailAdapter();

      const result = await resetTwoFactor(
        db,
        org.id,
        { targetUserId: staff, actorId: owner, actorPassword: PASSWORD },
        { email },
        env,
      );

      expect(result.emailed).toBe(true);
      expect(email.sent).toHaveLength(1);
      expect(email.sent[0]!.to).toBe(target!.email);
      expect(email.sent[0]!.subject).toBe("Your two-factor authentication was reset");
      // Nothing that came out of the `two_factor` row may reach an inbox.
      expect(email.sent[0]!.text).not.toMatch(/encrypted-/);

      const notifications = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.organisationId, org.id));
      expect(notifications.map((n) => n.kind)).toEqual(["security.two_factor_reset"]);
      expect(notifications[0]!.body).toContain("have been emailed");
    });
  });

  it("keeps the reset when the notice cannot be sent, and says so on the bell", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const owner = await makeMember(db, org.id, "owner", { password: PASSWORD });
      const staff = await makeMember(db, org.id, "staff", { enrolled: true });
      const email = {
        name: "mock" as const,
        send: async () => {
          throw new Error("smtp is down");
        },
      };

      const result = await resetTwoFactor(
        db,
        org.id,
        { targetUserId: staff, actorId: owner, actorPassword: PASSWORD },
        { email },
        env,
      );

      expect(result.emailed).toBe(false);
      expect(await enrolments(db, staff)).toHaveLength(0);
      const notifications = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.organisationId, org.id));
      expect(notifications[0]!.body).toContain("could not be sent");
    });
  });

  it("tells an enforced team member they will be asked to enrol again on their next sign-in", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db, true);
      const owner = await makeMember(db, org.id, "owner", { enrolled: true, password: PASSWORD });
      const staff = await makeMember(db, org.id, "staff", { enrolled: true });
      const email = new MockEmailAdapter();

      await resetTwoFactor(db, org.id, { targetUserId: staff, actorId: owner, actorPassword: PASSWORD }, { email }, env);

      expect(email.sent[0]!.text).toContain("next time you sign in");
    });
  });

  it("resets a portal user and points them at the portal's own account page", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const owner = await makeMember(db, org.id, "owner", { password: PASSWORD });
      const portal = await makePortalUser(db, org.id, { enrolled: true });
      const email = new MockEmailAdapter();

      const result = await resetTwoFactor(
        db,
        org.id,
        { targetUserId: portal, actorId: owner, actorPassword: PASSWORD },
        { email },
        env,
      );

      expect(result.kind).toBe("portal");
      expect(await enrolments(db, portal)).toHaveLength(0);
      expect(email.sent[0]!.text).toContain("/portal/account");
    });
  });

  it("lets an owner reset another owner", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const owner = await makeMember(db, org.id, "owner", { password: PASSWORD });
      const other = await makeMember(db, org.id, "owner", { enrolled: true });

      await resetTwoFactor(db, org.id, { targetUserId: other, actorId: owner, actorPassword: PASSWORD }, {}, env);

      expect(await enrolments(db, other)).toHaveLength(0);
    });
  });

  it("refuses a staff member resetting another staff member", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const actor = await makeMember(db, org.id, "staff", { password: PASSWORD });
      const target = await makeMember(db, org.id, "staff", { enrolled: true });

      await expect(
        resetTwoFactor(db, org.id, { targetUserId: target, actorId: actor, actorPassword: PASSWORD }, {}, env),
      ).rejects.toThrow(TwoFactorResetRefused);
      expect(await enrolments(db, target)).toHaveLength(1);
      expect(await auditRows(db, org.id)).toHaveLength(0);
    });
  });

  it("refuses a staff member resetting an owner", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const actor = await makeMember(db, org.id, "staff", { password: PASSWORD });
      const target = await makeMember(db, org.id, "owner", { enrolled: true });

      await expect(
        resetTwoFactor(db, org.id, { targetUserId: target, actorId: actor, actorPassword: PASSWORD }, {}, env),
      ).rejects.toThrow("Only an owner can reset somebody else's two-factor.");
      expect(await enrolments(db, target)).toHaveLength(1);
    });
  });

  it("refuses an owner whose membership has been suspended", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const actor = await makeMember(db, org.id, "owner", { password: PASSWORD });
      await db
        .update(schema.organisationMembers)
        .set({ status: "suspended" })
        .where(eq(schema.organisationMembers.userId, actor));
      const target = await makeMember(db, org.id, "staff", { enrolled: true });

      await expect(
        resetTwoFactor(db, org.id, { targetUserId: target, actorId: actor, actorPassword: PASSWORD }, {}, env),
      ).rejects.toThrow(TwoFactorResetRefused);
      expect(await enrolments(db, target)).toHaveLength(1);
    });
  });

  it("refuses a wrong password even from the right owner", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const owner = await makeMember(db, org.id, "owner", { password: PASSWORD });
      const staff = await makeMember(db, org.id, "staff", { enrolled: true });

      await expect(
        resetTwoFactor(db, org.id, { targetUserId: staff, actorId: owner, actorPassword: "not-the-password" }, {}, env),
      ).rejects.toThrow("That password was not accepted.");
      expect(await enrolments(db, staff)).toHaveLength(1);
      expect(await auditRows(db, org.id)).toHaveLength(0);
    });
  });

  it("refuses an owner resetting their own factor — that is the Account screen's job", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const owner = await makeMember(db, org.id, "owner", { enrolled: true, password: PASSWORD });

      await expect(
        resetTwoFactor(db, org.id, { targetUserId: owner, actorId: owner, actorPassword: PASSWORD }, {}, env),
      ).rejects.toThrow("Account screen");
      expect(await enrolments(db, owner)).toHaveLength(1);
    });
  });

  it("refuses a target in another organisation", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      const owner = await makeMember(db, mine.id, "owner", { password: PASSWORD });
      const stranger = await makeMember(db, theirs.id, "staff", { enrolled: true });

      await expect(
        resetTwoFactor(db, mine.id, { targetUserId: stranger, actorId: owner, actorPassword: PASSWORD }, {}, env),
      ).rejects.toThrow("not part of this organisation");
      expect(await enrolments(db, stranger)).toHaveLength(1);
      expect(await auditRows(db, mine.id)).toHaveLength(0);
      expect(await auditRows(db, theirs.id)).toHaveLength(0);
    });
  });

  it("refuses an owner of another organisation reaching into this one", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      const stranger = await makeMember(db, theirs.id, "owner", { password: PASSWORD });
      const staff = await makeMember(db, mine.id, "staff", { enrolled: true });

      await expect(
        resetTwoFactor(db, mine.id, { targetUserId: staff, actorId: stranger, actorPassword: PASSWORD }, {}, env),
      ).rejects.toThrow(TwoFactorResetRefused);
      expect(await enrolments(db, staff)).toHaveLength(1);
    });
  });

  it("refuses an account that has no second factor to take off", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const owner = await makeMember(db, org.id, "owner", { password: PASSWORD });
      const staff = await makeMember(db, org.id, "staff");

      await expect(
        resetTwoFactor(db, org.id, { targetUserId: staff, actorId: owner, actorPassword: PASSWORD }, {}, env),
      ).rejects.toThrow("does not have two-factor set up");
      expect(await auditRows(db, org.id)).toHaveLength(0);
    });
  });
});
