import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { createClient } from "@launchos/core";
import { runRaiseDueInvoices } from "./billing-raise-due.js";

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
const silent = { info: () => {}, error: () => {} };

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  // With no owner membership `notifyOwner` has nobody to ring and returns null,
  // which is correct and would make the bell assertions vacuous.
  const ownerId = crypto.randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `owner-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner", status: "active" });
  return org!;
}

async function retainer(
  db: Db,
  organisationId: string,
  over: { name: string; collectionMethod?: "stripe" | "bank_transfer"; noticeDays?: number },
) {
  const client = await createClient(db, organisationId, { name: over.name });
  if (over.noticeDays !== undefined) {
    await db.update(schema.billingProfiles)
      .set({ paymentTermsDays: over.noticeDays })
      .where(eq(schema.billingProfiles.clientId, client.id));
  }
  const [subscription] = await db.insert(schema.subscriptions).values({
    organisationId, clientId: client.id, status: "active",
    currentPeriodStart: at("2026-09-05"), currentPeriodEnd: at("2026-10-05"),
    amountPence: 20000, currency: "GBP",
    collectionMethod: over.collectionMethod ?? "bank_transfer",
  }).returning();
  return { client, subscription: subscription! };
}

const invoicesOf = (db: Db, organisationId: string) =>
  db.select().from(schema.invoices).where(eq(schema.invoices.organisationId, organisationId));

const pendingSends = (db: Db, organisationId: string) =>
  db.select().from(schema.approvals).where(and(
    eq(schema.approvals.organisationId, organisationId),
    eq(schema.approvals.status, "pending"),
  ));

describe("runRaiseDueInvoices", () => {
  it("raises the invoice on the notice date and parks the send for a person", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await retainer(db, org.id, { name: "AMO Rendering", noticeDays: 7 });

      const result = await runRaiseDueInvoices({ db, logger: silent }, org.id, at("2026-08-29"));

      expect(result).toMatchObject({ due: 1, raised: 1, queued: 1, failed: 0 });
      const [invoice] = await invoicesOf(db, org.id);
      expect(invoice!.dueAt).toEqual(at("2026-09-05"));
      expect(invoice!.issuedAt).toEqual(at("2026-08-29"));
      // Parked, not sent. Money leaving on a wrong figure cannot be taken back.
      expect(invoice!.status).toBe("draft");
      expect(await pendingSends(db, org.id)).toHaveLength(1);
    });
  });

  it("does nothing before the notice date", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await retainer(db, org.id, { name: "AMO Rendering", noticeDays: 7 });

      expect(await runRaiseDueInvoices({ db, logger: silent }, org.id, at("2026-08-28")))
        .toMatchObject({ due: 0, raised: 0, queued: 0 });
      expect(await invoicesOf(db, org.id)).toHaveLength(0);
    });
  });

  /** The cron runs daily. Twice in one day must not bill a client twice. */
  it("is idempotent: a second run the same day raises nothing", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await retainer(db, org.id, { name: "AMO Rendering", noticeDays: 7 });

      await runRaiseDueInvoices({ db, logger: silent }, org.id, at("2026-08-29"));
      const second = await runRaiseDueInvoices({ db, logger: silent }, org.id, at("2026-08-29"));

      expect(second).toMatchObject({ due: 0, raised: 0 });
      expect(await invoicesOf(db, org.id)).toHaveLength(1);
      expect(await pendingSends(db, org.id)).toHaveLength(1);
    });
  });

  it("leaves Stripe clients alone entirely", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await retainer(db, org.id, { name: "Stripe client", collectionMethod: "stripe", noticeDays: 7 });

      expect(await runRaiseDueInvoices({ db, logger: silent }, org.id, at("2026-09-30")))
        .toMatchObject({ due: 0, raised: 0 });
      expect(await invoicesOf(db, org.id)).toHaveLength(0);
    });
  });

  it("rings the owner once with what is waiting, not once per invoice", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await retainer(db, org.id, { name: "AMO Rendering", noticeDays: 7 });
      await retainer(db, org.id, { name: "Gateway Taxis", noticeDays: 7 });

      await runRaiseDueInvoices({ db, logger: silent }, org.id, at("2026-08-29"));

      const bells = await db.select().from(schema.notifications)
        .where(and(eq(schema.notifications.organisationId, org.id), eq(schema.notifications.kind, "invoice.raised")));
      expect(bells).toHaveLength(1);
      expect(bells[0]!.title).toContain("2 invoices");
    });
  });
});
