import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { recordTwoFactorEvent } from "./two-factor-events.js";
import {
  setStaffTwoFactorRequired,
  staffTwoFactorRequired,
  staffWithoutTwoFactor,
  TwoFactorPolicyRefused,
} from "./two-factor-policy.js";

async function makeOrg(db: Db) {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: "T", slug: `t-${crypto.randomUUID()}` })
    .returning();
  return org!;
}

async function makeUser(db: Db, twoFactorEnabled = false) {
  const id = `u-${crypto.randomUUID()}`;
  await db.insert(schema.user).values({ id, name: "Member", email: `${id}@example.com`, twoFactorEnabled });
  return id;
}

async function makeMember(db: Db, organisationId: string, role: "owner" | "staff", twoFactorEnabled = false) {
  const userId = await makeUser(db, twoFactorEnabled);
  await db.insert(schema.organisationMembers).values({ organisationId, userId, role });
  return userId;
}

async function auditActions(db: Db, organisationId: string) {
  const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.organisationId, organisationId));
  return rows.map((row) => row.action);
}

describe("recordTwoFactorEvent", () => {
  it("files a staff event against the member's organisation", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const userId = await makeMember(db, org.id, "staff");

      const result = await recordTwoFactorEvent(db, { userId, event: "enabled", ip: "1.2.3.4", userAgent: "Firefox" });

      expect(result).toMatchObject({ organisationId: org.id, actorKind: "user" });
      expect(await auditActions(db, org.id)).toEqual(["security.two_factor_enabled"]);
    });
  });

  it("never writes a code or a secret into the audit row", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const userId = await makeMember(db, org.id, "staff");

      await recordTwoFactorEvent(db, { userId, event: "backup_code_used", ip: null, userAgent: null });

      const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.organisationId, org.id));
      expect(JSON.stringify(row!.after)).not.toMatch(/secret|backupCode|[0-9a-z]{5}-[0-9a-z]{5}/i);
    });
  });

  it("rings the owner's bell when a second factor is switched off", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await makeMember(db, org.id, "owner");
      const staffId = await makeMember(db, org.id, "staff");

      await recordTwoFactorEvent(db, { userId: staffId, event: "disabled" });

      const notifications = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.organisationId, org.id));
      expect(notifications.map((n) => n.kind)).toEqual(["security.two_factor_disabled"]);
      expect(notifications[0]!.title).toBe("Two-factor authentication switched off");
    });
  });

  it("files a rejected code but does not interrupt anybody with it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await makeMember(db, org.id, "owner");
      const staffId = await makeMember(db, org.id, "staff");

      await recordTwoFactorEvent(db, { userId: staffId, event: "challenge_failed" });

      expect(await auditActions(db, org.id)).toContain("security.two_factor_challenge_failed");
      const notifications = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.organisationId, org.id));
      expect(notifications).toHaveLength(0);
    });
  });

  it("files a portal user's event as a client action on their organisation", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const [client] = await db
        .insert(schema.clients)
        .values({ organisationId: org.id, name: "Acme", slug: `acme-${crypto.randomUUID()}` })
        .returning();
      const userId = await makeUser(db);
      await db.insert(schema.clientUsers).values({ organisationId: org.id, clientId: client!.id, userId });

      const result = await recordTwoFactorEvent(db, { userId, event: "enabled" });

      expect(result).toMatchObject({ organisationId: org.id, actorKind: "client" });
    });
  });

  it("returns null for a user who belongs to no organisation, rather than guessing one", async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db);
      expect(await recordTwoFactorEvent(db, { userId, event: "enabled" })).toBeNull();
    });
  });
});

describe("setStaffTwoFactorRequired", () => {
  it("refuses to switch enforcement on for an owner who has not enrolled", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const ownerId = await makeMember(db, org.id, "owner");

      await expect(setStaffTwoFactorRequired(db, org.id, { required: true, actorId: ownerId })).rejects.toBeInstanceOf(
        TwoFactorPolicyRefused,
      );
      expect(await staffTwoFactorRequired(db, org.id)).toBe(false);
      expect(await auditActions(db, org.id)).toEqual([]);
    });
  });

  it("switches on for an enrolled owner and audits the change", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const ownerId = await makeMember(db, org.id, "owner", true);

      expect(await setStaffTwoFactorRequired(db, org.id, { required: true, actorId: ownerId })).toBe(true);
      expect(await staffTwoFactorRequired(db, org.id)).toBe(true);
      expect(await auditActions(db, org.id)).toEqual(["organisation.two_factor_policy_updated"]);
    });
  });

  it("switches off without asking the owner to be enrolled — the valve must not need the thing it protects against", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const enrolled = await makeMember(db, org.id, "owner", true);
      await setStaffTwoFactorRequired(db, org.id, { required: true, actorId: enrolled });

      const other = await makeMember(db, org.id, "owner");
      expect(await setStaffTwoFactorRequired(db, org.id, { required: false, actorId: other })).toBe(false);
    });
  });

  it("lists the active members enforcement would shut out", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await makeMember(db, org.id, "owner", true);
      const unenrolled = await makeMember(db, org.id, "staff");
      const suspended = await makeMember(db, org.id, "staff");
      await db
        .update(schema.organisationMembers)
        .set({ status: "suspended" })
        .where(
          and(
            eq(schema.organisationMembers.organisationId, org.id),
            eq(schema.organisationMembers.userId, suspended),
          ),
        );

      const rows = await staffWithoutTwoFactor(db, org.id);
      expect(rows.map((r) => r.userId)).toEqual([unenrolled]);
    });
  });
});
