import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { getBillingProfile, upsertBillingProfile } from "./upsert-billing-profile.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("upsertBillingProfile", () => {
  it("patches the profile createClient opened and never creates a second one", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Acme" });

      const saved = await upsertBillingProfile(db, org.id, {
        clientId: client.id, billingName: "Acme Ltd", vatNumber: "GB123456789", paymentTermsDays: 30, preferredMethod: "Bank transfer",
      });
      expect(saved.paymentTermsDays).toBe(30);

      const again = await upsertBillingProfile(db, org.id, { clientId: client.id, city: "Grays" });
      expect(again.id).toBe(saved.id);
      expect(again.vatNumber).toBe("GB123456789");
      expect((await getBillingProfile(db, org.id, client.id))?.city).toBe("Grays");
    });
  });
});
