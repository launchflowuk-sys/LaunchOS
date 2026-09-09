import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { MockRegistrarAdapter } from "@launchos/integrations";
import type { SupplierSubscription } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { createClient } from "../clients/create-client.js";
import { assignSupplierCost, listSupplierCosts, syncSupplierCosts } from "./supplier-costs.js";

const at = (iso: string) => new Date(iso);

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

async function makeDomain(db: Db, organisationId: string, clientId: string, name: string, registeredAt: Date | null) {
  const [row] = await db
    .insert(schema.domains)
    .values({ organisationId, clientId, name, registeredAt })
    .returning();
  return row!;
}

const sub = (over: Partial<SupplierSubscription> & { id: string; name: string }): SupplierSubscription => ({
  status: "active",
  renewalPrice: 1_200,
  totalPrice: 1_200,
  currencyCode: "USD",
  billingPeriod: 1,
  billingPeriodUnit: "year",
  autoRenewed: true,
  nextBillingAt: at("2027-04-12T19:19:35Z"),
  startedAt: at("2026-04-12T19:19:35Z"),
  ...over,
});

describe("syncSupplierCosts", () => {
  /**
   * The failure this replaced: seven `.co.uk` domains and seven `.CO.UK Domain`
   * lines meant the TLD narrowed nothing, so every row arrived unassigned and
   * fifty-three of them sat there. The purchase moment tells them apart.
   */
  it("tells two domains of the same TLD apart by when they were bought", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const one = await createClient(db, org.id, { name: "Grays CabLine" });
      const two = await createClient(db, org.id, { name: "Moodera" });
      const first = await makeDomain(db, org.id, one.id, "graystowntaxis.co.uk", at("2026-04-12T19:19:37Z"));
      const second = await makeDomain(db, org.id, two.id, "mooderaboutique.co.uk", at("2026-08-18T21:44:26Z"));

      await syncSupplierCosts(db, org.id, new MockRegistrarAdapter([], [
        sub({ id: "s1", name: ".CO.UK Domain", startedAt: at("2026-04-12T19:19:35Z") }),
        sub({ id: "s2", name: ".CO.UK Domain", startedAt: at("2026-08-18T21:44:20Z") }),
      ]));

      const rows = await listSupplierCosts(db, org.id);
      const byExternal = new Map(
        (await db.select().from(schema.supplierCosts).where(eq(schema.supplierCosts.organisationId, org.id)))
          .map((row) => [row.externalId, row]),
      );
      expect(byExternal.get("s1")!.domainId).toBe(first.id);
      expect(byExternal.get("s1")!.clientId).toBe(one.id);
      expect(byExternal.get("s2")!.domainId).toBe(second.id);
      expect(byExternal.get("s2")!.clientId).toBe(two.id);
      expect(rows.every((row) => row.match === "suggested")).toBe(true);
    });
  });

  // The screen used to print the supplier's product name because the column it
  // needed was never selected back out.
  it("reports the domain a line pays for, not just the supplier's product name", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Grays CabLine" });
      await makeDomain(db, org.id, client.id, "graystowntaxis.co.uk", at("2026-04-12T19:19:37Z"));

      await syncSupplierCosts(db, org.id, new MockRegistrarAdapter([], [
        sub({ id: "s1", name: ".CO.UK Domain", startedAt: at("2026-04-12T19:19:35Z") }),
      ]));

      const [row] = await listSupplierCosts(db, org.id);
      expect(row!.domainName).toBe("graystowntaxis.co.uk");
      expect(row!.name).toBe(".CO.UK Domain");
      expect(row!.startedAt).toEqual(at("2026-04-12T19:19:35Z"));
    });
  });

  it("leaves a line alone when two domains of that TLD were bought in the same minute", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Someone" });
      await makeDomain(db, org.id, client.id, "one.co.uk", at("2026-04-12T19:19:30Z"));
      await makeDomain(db, org.id, client.id, "two.co.uk", at("2026-04-12T19:19:40Z"));

      await syncSupplierCosts(db, org.id, new MockRegistrarAdapter([], [
        sub({ id: "s1", name: ".CO.UK Domain", startedAt: at("2026-04-12T19:19:35Z") }),
      ]));

      const [row] = await listSupplierCosts(db, org.id);
      expect(row!.match).toBe("unassigned");
      expect(row!.clientId).toBeNull();
      expect(row!.domainName).toBeNull();
    });
  });

  it("never overwrites an answer a person confirmed", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const guessed = await createClient(db, org.id, { name: "Guessed at" });
      const truth = await createClient(db, org.id, { name: "Actually theirs" });
      await makeDomain(db, org.id, guessed.id, "graystowntaxis.co.uk", at("2026-04-12T19:19:37Z"));

      const registrar = new MockRegistrarAdapter([], [
        sub({ id: "s1", name: ".CO.UK Domain", startedAt: at("2026-04-12T19:19:35Z") }),
      ]);
      await syncSupplierCosts(db, org.id, registrar);
      const [before] = await listSupplierCosts(db, org.id);
      await assignSupplierCost(db, org.id, { costId: before!.id, clientId: truth.id, actorId: "u1" });

      await syncSupplierCosts(db, org.id, registrar);

      const [after] = await listSupplierCosts(db, org.id);
      expect(after!.clientId).toBe(truth.id);
      expect(after!.match).toBe("confirmed");
    });
  });

  it("updates the money on every run, confirmed or not", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await syncSupplierCosts(db, org.id, new MockRegistrarAdapter([], [
        sub({ id: "s1", name: "Starter Business Email", renewalPrice: 3_540, status: "in_trial" }),
      ]));

      await syncSupplierCosts(db, org.id, new MockRegistrarAdapter([], [
        sub({ id: "s1", name: "Starter Business Email", renewalPrice: 4_200, status: "active" }),
      ]));

      const rows = await listSupplierCosts(db, org.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.renewalPrice).toBe(4_200);
      expect(rows[0]!.status).toBe("active");
    });
  });

  it("offers a mailbox to the one domain bought the same day, and no further", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Moodera" });
      const domain = await makeDomain(db, org.id, client.id, "mooderaboutique.co.uk", at("2026-08-18T21:44:26Z"));

      await syncSupplierCosts(db, org.id, new MockRegistrarAdapter([], [
        sub({ id: "e1", name: "Starter Business Email", status: "in_trial", startedAt: at("2026-08-18T21:45:00Z") }),
        sub({ id: "e2", name: "Starter Business Email", status: "in_trial", startedAt: at("2026-01-01T00:00:00Z") }),
      ]));

      const rows = await listSupplierCosts(db, org.id);
      const matched = rows.find((row) => row.domainName !== null);
      expect(matched?.domainName).toBe(domain.name);
      expect(rows.filter((row) => row.clientId === null)).toHaveLength(1);
    });
  });

  it("never reaches another organisation's domains", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      const theirClient = await createClient(db, theirs.id, { name: "Not mine" });
      await makeDomain(db, theirs.id, theirClient.id, "graystowntaxis.co.uk", at("2026-04-12T19:19:37Z"));

      await syncSupplierCosts(db, mine.id, new MockRegistrarAdapter([], [
        sub({ id: "s1", name: ".CO.UK Domain", startedAt: at("2026-04-12T19:19:35Z") }),
      ]));

      const [row] = await listSupplierCosts(db, mine.id);
      expect(row!.clientId).toBeNull();
      const theirRows = await db
        .select()
        .from(schema.supplierCosts)
        .where(and(eq(schema.supplierCosts.organisationId, theirs.id)));
      expect(theirRows).toHaveLength(0);
    });
  });
});
