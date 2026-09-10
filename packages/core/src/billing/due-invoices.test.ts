import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { subscriptionsDueToInvoice } from "./due-invoices.js";
import { createInvoiceFromSubscription } from "./invoices.js";

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

async function retainer(
  db: Db,
  organisationId: string,
  over: { name: string; collectionMethod?: "stripe" | "bank_transfer"; periodStart?: Date; noticeDays?: number; status?: "active" | "cancelled" },
) {
  const client = await createClient(db, organisationId, { name: over.name });
  // `createClient` already writes a billing profile, so this updates rather
  // than inserts — and `payment_terms_days` defaults to 14 there, which is the
  // notice every client gets until somebody sets their own.
  if (over.noticeDays !== undefined) {
    await db.update(schema.billingProfiles)
      .set({ paymentTermsDays: over.noticeDays })
      .where(eq(schema.billingProfiles.clientId, client.id));
  }
  const [subscription] = await db.insert(schema.subscriptions).values({
    organisationId, clientId: client.id, status: over.status ?? "active",
    currentPeriodStart: over.periodStart ?? at("2026-09-05"),
    currentPeriodEnd: at("2026-10-05"),
    amountPence: 20000, currency: "GBP",
    collectionMethod: over.collectionMethod ?? "bank_transfer",
  }).returning();
  return { client, subscription: subscription! };
}

describe("subscriptionsDueToInvoice", () => {
  /** Seven days' notice on a period starting the 5th means sending on the 29th. */
  it("is not due before the notice date, and is on it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await retainer(db, org.id, { name: "AMO Rendering", noticeDays: 7 });

      expect(await subscriptionsDueToInvoice(db, org.id, at("2026-08-28"))).toHaveLength(0);
      const due = await subscriptionsDueToInvoice(db, org.id, at("2026-08-29"));
      expect(due).toHaveLength(1);
      expect(due[0]!.dates.dueAt).toEqual(at("2026-09-05"));
      expect(due[0]!.dates.issuedAt).toEqual(at("2026-08-29"));
    });
  });

  it("never raises one for Stripe, which collects on its own", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await retainer(db, org.id, { name: "Stripe client", collectionMethod: "stripe", noticeDays: 7 });

      expect(await subscriptionsDueToInvoice(db, org.id, at("2026-09-30"))).toHaveLength(0);
    });
  });

  /** The sweep runs daily; it must not bill somebody twice for the same period. */
  it("stops being due once the invoice for that period exists", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { subscription } = await retainer(db, org.id, { name: "AMO Rendering", noticeDays: 7 });

      await createInvoiceFromSubscription(db, org.id, { subscriptionId: subscription.id });

      expect(await subscriptionsDueToInvoice(db, org.id, at("2026-09-01"))).toHaveLength(0);
    });
  });

  it("ignores a cancelled retainer and an archived client", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await retainer(db, org.id, { name: "Gone", status: "cancelled", noticeDays: 7 });
      const { client } = await retainer(db, org.id, { name: "Archived", noticeDays: 7 });
      await db.update(schema.clients).set({ status: "archived" }).where(eq(schema.clients.id, client.id));

      expect(await subscriptionsDueToInvoice(db, org.id, at("2026-09-01"))).toHaveLength(0);
    });
  });

  /**
   * Every client gets a billing profile the moment it is created, and its
   * `payment_terms_days` starts at 14 — so fourteen days is the notice anybody
   * gets until Shoji sets their own. Worth pinning: it is the number that
   * decides when a client is asked for money.
   */
  it("uses the client's own notice period, which starts at fourteen days", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await retainer(db, org.id, { name: "Untouched profile" });

      expect(await subscriptionsDueToInvoice(db, org.id, at("2026-08-21"))).toHaveLength(0);
      expect(await subscriptionsDueToInvoice(db, org.id, at("2026-08-22"))).toHaveLength(1);
    });
  });

  it("never reaches another organisation's retainers", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      await retainer(db, theirs.id, { name: "Not mine", noticeDays: 7 });

      expect(await subscriptionsDueToInvoice(db, mine.id, at("2026-09-30"))).toHaveLength(0);
    });
  });
});
