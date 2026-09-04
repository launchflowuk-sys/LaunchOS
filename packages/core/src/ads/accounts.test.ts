import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq } from "drizzle-orm";
import { createAdAccount, listAdAccounts, updateAdAccount } from "./accounts.js";

async function orgWithClient(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `acc-${randomUUID()}` }).returning();
  const [client] = await db.insert(schema.clients)
    .values({ organisationId: org!.id, name: "Grays CabLine", slug: `grays-${randomUUID()}` }).returning();
  return { orgId: org!.id, clientId: client!.id };
}

const base = (clientId: string) => ({ clientId, platform: "google" as const, externalId: "123-456", name: "Search" });

describe("createAdAccount currency validation", () => {
  it("refuses a three-character code that is not three letters", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      // `12X` is exactly the shape `length(3)` used to let through, and exactly
      // the shape Intl.NumberFormat throws RangeError on.
      await expect(createAdAccount(db, orgId, { ...base(clientId), currency: "12X" }))
        .rejects.toThrow(/three-letter code/);
      await expect(createAdAccount(db, orgId, { ...base(clientId), currency: "G B" }))
        .rejects.toThrow(/three-letter code/);
      const [written] = await db.select().from(schema.adAccounts).where(eq(schema.adAccounts.organisationId, orgId));
      expect(written).toBeUndefined();
    });
  });

  it("trims and uppercases a well-formed code", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      const account = await createAdAccount(db, orgId, { ...base(clientId), currency: " eur " });
      expect(account.currency).toBe("EUR");
      // Well formed but unknown is fine: Intl renders it, it does not throw.
      expect(new Intl.NumberFormat("en-GB", { style: "currency", currency: account.currency }).format(1)).toContain("1");
    });
  });

  it("defaults to GBP when no currency is given", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      const account = await createAdAccount(db, orgId, base(clientId));
      expect(account.currency).toBe("GBP");
    });
  });
});

describe("createAdAccount duplicates", () => {
  it("reports the same platform and external id in words, not as a constraint name", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      await createAdAccount(db, orgId, base(clientId));
      const message = await createAdAccount(db, orgId, { ...base(clientId), name: "Search — brand" })
        .then(() => "no error", (error: unknown) => (error as Error).message);
      expect(message).toMatch(/Google account \(123-456\) is already connected/);
      expect(message).not.toMatch(/constraint|23505/);
    });
  });

  it("lets another organisation connect the same external id", async () => {
    await withTestDb(async (db) => {
      const a = await orgWithClient(db);
      const b = await orgWithClient(db);
      await createAdAccount(db, a.orgId, base(a.clientId));
      const other = await createAdAccount(db, b.orgId, base(b.clientId));
      expect(other.externalId).toBe("123-456");
    });
  });
});

describe("updateAdAccount", () => {
  it("changes name, currency and status, and audits the change", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      const account = await createAdAccount(db, orgId, { ...base(clientId), currency: "GBP" });

      const after = await updateAdAccount(db, orgId, {
        adAccountId: account.id, name: "Search — brand", currency: "usd", status: "paused", actorId: "u-1",
      });
      expect(after.name).toBe("Search — brand");
      expect(after.currency).toBe("USD");
      expect(after.status).toBe("paused");

      const [audit] = await db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.organisationId, orgId),
        eq(schema.auditLog.action, "ad_account.updated"),
      ));
      expect(audit).toBeDefined();
      expect(audit!.targetId).toBe(account.id);
    });
  });

  it("refuses a currency that is not three letters", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      const account = await createAdAccount(db, orgId, base(clientId));
      await expect(updateAdAccount(db, orgId, { adAccountId: account.id, currency: "£$€" }))
        .rejects.toThrow(/three-letter code/);
      const [unchanged] = await db.select().from(schema.adAccounts).where(eq(schema.adAccounts.id, account.id));
      expect(unchanged!.currency).toBe("GBP");
    });
  });

  it("refuses an account belonging to another organisation and changes nothing", async () => {
    await withTestDb(async (db) => {
      const a = await orgWithClient(db);
      const b = await orgWithClient(db);
      const account = await createAdAccount(db, a.orgId, base(a.clientId));

      await expect(updateAdAccount(db, b.orgId, { adAccountId: account.id, name: "Stolen" }))
        .rejects.toThrow(/not found in organisation/);
      const [unchanged] = await db.select().from(schema.adAccounts).where(eq(schema.adAccounts.id, account.id));
      expect(unchanged!.name).toBe("Search");
    });
  });
});

describe("listAdAccounts", () => {
  it("is bounded by the caller's limit", async () => {
    await withTestDb(async (db) => {
      const { orgId, clientId } = await orgWithClient(db);
      for (const externalId of ["a", "b", "c"]) {
        await createAdAccount(db, orgId, { ...base(clientId), externalId, name: `Account ${externalId}` });
      }
      expect(await listAdAccounts(db, orgId)).toHaveLength(3);
      expect(await listAdAccounts(db, orgId, { limit: 2 })).toHaveLength(2);
    });
  });
});
