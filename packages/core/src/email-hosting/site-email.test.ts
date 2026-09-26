import { beforeEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import {
  mockHostingerMailClient,
  type EmailSubscription,
  type MailboxUsage,
  type MailOrder,
} from "@launchos/integrations";
import { createClient } from "../clients/create-client.js";
import { setFxRate } from "../costs/fx.js";
import { setEnqueue } from "../events/emit.js";
import { siteEmailSummary } from "./site-email.js";

const EXPIRES = new Date("2027-09-22T11:52:24Z");
const NOW = new Date("2026-09-26T12:00:00Z");

async function setup(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const client = await createClient(db, org!.id, { name: "Kten" });
  const tag = crypto.randomUUID().slice(0, 8);
  const primary = `kten-${tag}.test`;
  const extra = `kten-extra-${tag}.test`;
  const [site] = await db
    .insert(schema.sites)
    .values({ organisationId: org!.id, clientId: client.id, name: "Kten", primaryUrl: `https://www.${primary}/` })
    .returning();
  await db.insert(schema.domains).values({ organisationId: org!.id, clientId: client.id, siteId: site!.id, name: extra });
  return { orgId: org!.id, siteId: site!.id, primary, extra };
}

function order(id: string, domain: string, extra: Partial<MailOrder> = {}): MailOrder {
  return { id, status: "active", isTrial: false, seats: 5, domain, planTitle: "Starter Business Email", createdAt: null, expiresAt: EXPIRES, ...extra };
}

function box(address: string, usedKb: number, quotaKb = 1_000_000): MailboxUsage {
  return { id: address, address, status: "active", storageUsedKb: usedKb, storageQuotaKb: quotaKb, messagesUsed: 9, messagesQuota: 15000 };
}

function sub(id: string, extra: Partial<EmailSubscription> = {}): EmailSubscription {
  return {
    id,
    name: "Starter Business Email",
    status: "active",
    renewalPrice: 3600, // $36.00 a year
    currencyCode: "USD",
    billingPeriod: 1,
    billingPeriodUnit: "year",
    autoRenewed: true,
    expiresAt: new Date(EXPIRES.getTime() + 60_000),
    nextBillingAt: new Date("2027-09-15T11:52:24Z"),
    ...extra,
  };
}

describe("siteEmailSummary", () => {
  beforeEach(() => setEnqueue(async () => {}));

  it("lists the site's orders and mailboxes with cost in USD and GBP", async () => {
    await withTestDb(async (db) => {
      const { orgId, siteId, primary, extra } = await setup(db);
      await setFxRate(db, orgId, { day: new Date("2026-09-01"), base: "USD", rate: 0.75 });
      const mail = mockHostingerMailClient({
        orders: [
          order("OR1", primary),
          order("OR2", extra, { seats: 2, expiresAt: new Date("2028-01-01T00:00:00Z") }),
          order("OR9", "someone-else.test", { expiresAt: new Date("2029-01-01T00:00:00Z") }),
        ],
        mailboxes: { OR1: [box(`info@${primary}`, 800_000), box(`sales@${primary}`, 950_000)], OR2: [box(`a@${extra}`, 10)] },
        subscriptions: [sub("s1"), sub("s2", { expiresAt: new Date("2028-01-01T00:00:00Z") })],
      });

      const result = await siteEmailSummary(db, orgId, siteId, { mail, now: NOW });
      if (!result.ok) throw new Error(result.message);

      expect(result.orders.map((o) => o.domain).sort()).toEqual([extra, primary].sort());
      const main = result.orders.find((o) => o.orderId === "OR1")!;
      expect(main).toMatchObject({ seats: 5, used: 2, isTrial: false, planTitle: "Starter Business Email" });
      expect(main.cost).toMatchObject({
        currency: "USD",
        monthlyCostMinor: 300,
        monthlyCostGbpMinor: 225,
        perMailboxMonthlyMinor: 150,
        perMailboxMonthlyGbpMinor: 113,
      });
      expect(main.renewsAt?.toISOString()).toBe("2027-09-15T11:52:24.000Z");
      expect(main.mailboxes[0]).toMatchObject({ address: `info@${primary}`, storagePct: 80, monthlyShareMinor: 150 });
      expect(main.mailboxes[1]!.storagePct).toBe(95);
      expect(result.missingRate).toEqual([]);
    });
  });

  it("marks cost unknown when two orders share one subscription's expiry", async () => {
    await withTestDb(async (db) => {
      const { orgId, siteId, primary } = await setup(db);
      const mail = mockHostingerMailClient({
        orders: [order("OR1", primary), order("OR9", "elsewhere.test")],
        subscriptions: [sub("s1")],
      });
      const result = await siteEmailSummary(db, orgId, siteId, { mail, now: NOW });
      if (!result.ok) throw new Error(result.message);
      expect(result.orders[0]!.cost).toBeNull();
      expect(result.totals.monthlyCostGbpMinor).toBeNull();
    });
  });

  it("marks cost unknown when no subscription matches", async () => {
    await withTestDb(async (db) => {
      const { orgId, siteId, primary } = await setup(db);
      const mail = mockHostingerMailClient({
        orders: [order("OR1", primary)],
        subscriptions: [sub("s1", { expiresAt: new Date("2027-12-25T00:00:00Z") })],
      });
      const result = await siteEmailSummary(db, orgId, siteId, { mail, now: NOW });
      if (!result.ok) throw new Error(result.message);
      expect(result.orders[0]!.cost).toBeNull();
    });
  });

  it("shows a trial as free now with the price it becomes", async () => {
    await withTestDb(async (db) => {
      const { orgId, siteId, primary } = await setup(db);
      await setFxRate(db, orgId, { day: new Date("2026-09-01"), base: "USD", rate: 0.75 });
      const mail = mockHostingerMailClient({
        orders: [order("OR1", primary, { isTrial: true })],
        mailboxes: { OR1: [box(`info@${primary}`, 1)] },
        subscriptions: [sub("s1", { status: "in_trial" })],
      });
      const result = await siteEmailSummary(db, orgId, siteId, { mail, now: NOW });
      if (!result.ok) throw new Error(result.message);
      const o = result.orders[0]!;
      expect(o.isTrial).toBe(true);
      expect(o.cost?.monthlyCostGbpMinor).toBe(225);
      // A trial costs nothing today; the total says so rather than adding the future price.
      expect(result.totals.monthlyCostGbpMinor).toBe(0);
    });
  });

  it("never converts at 1.0 when the USD rate is missing", async () => {
    await withTestDb(async (db) => {
      const { orgId, siteId, primary } = await setup(db);
      const mail = mockHostingerMailClient({ orders: [order("OR1", primary)], subscriptions: [sub("s1")] });
      const result = await siteEmailSummary(db, orgId, siteId, { mail, now: NOW });
      if (!result.ok) throw new Error(result.message);
      expect(result.orders[0]!.cost).toMatchObject({ monthlyCostMinor: 300, monthlyCostGbpMinor: null });
      expect(result.missingRate).toEqual(["USD"]);
      expect(result.totals.monthlyCostGbpMinor).toBeNull();
    });
  });

  it("refuses a site from another organisation", async () => {
    await withTestDb(async (db) => {
      const mine = await setup(db);
      const theirs = await setup(db);
      const mail = mockHostingerMailClient({ orders: [order("OR1", theirs.primary)] });
      const result = await siteEmailSummary(db, mine.orgId, theirs.siteId, { mail, now: NOW });
      expect(result).toMatchObject({ ok: false, reason: "not_found" });
    });
  });

  it("says email is not connected when there is no client", async () => {
    await withTestDb(async (db) => {
      const { orgId, siteId } = await setup(db);
      expect(await siteEmailSummary(db, orgId, siteId, { mail: null })).toMatchObject({ ok: false, reason: "not_configured" });
    });
  });

  it("turns a provider failure into a message instead of throwing", async () => {
    await withTestDb(async (db) => {
      const { orgId, siteId } = await setup(db);
      const mail = { ...mockHostingerMailClient(), listOrders: async () => { throw new Error("hostinger-mail: the API returned 500"); } };
      const result = await siteEmailSummary(db, orgId, siteId, { mail, now: NOW });
      expect(result).toMatchObject({ ok: false, reason: "provider", message: expect.stringContaining("500") });
    });
  });
});
