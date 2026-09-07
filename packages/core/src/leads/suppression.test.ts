import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { ingestInboundEnquiry } from "./inbound-enquiry.js";
import { addSuppression, listSuppressions, removeSuppression, SuppressionRefused } from "./suppression.js";

describe("the never-contact list", () => {
  it("stores one number however it was typed, and adding it twice is not a telling-off", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);

      const first = await addSuppression(db, organisationId, { phone: "07700 900123", note: "Shumaila", actorId: ownerUserId });
      expect(first.alreadyThere).toBe(false);
      expect(first.row.phone).toBe("+447700900123");

      const again = await addSuppression(db, organisationId, { phone: "+44 7700 900123", actorId: ownerUserId });
      expect(again.alreadyThere).toBe(true);
      expect(again.row.id).toBe(first.row.id);
      // The original note survives a careless second add.
      expect(again.row.note).toBe("Shumaila");
      expect(await listSuppressions(db, organisationId)).toHaveLength(1);
    });
  });

  it("actually stops a lead being written, which is the only thing it is for", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      await addSuppression(db, organisationId, { phone: "07700 900123", actorId: ownerUserId });

      const blocked = await ingestInboundEnquiry(db, organisationId, {
        channel: "sms", from: "+447700900123", body: "how much for a website for the shop",
      });
      expect(blocked.action).toBe("suppressed");

      const rows = await listSuppressions(db, organisationId);
      await removeSuppression(db, organisationId, { id: rows[0]!.id, actorId: ownerUserId });

      const allowed = await ingestInboundEnquiry(db, organisationId, {
        channel: "sms", from: "+447700900123", body: "how much for a website for the shop",
      });
      expect(allowed.action).toBe("lead_created");
    });
  });

  it("refuses something that is not a number, and shrugs at removing one twice", async () => {
    await withTestDb(async (db) => {
      const { organisationId } = await seedOrgWithClient(db);
      await expect(addSuppression(db, organisationId, { phone: "  ---  " })).rejects.toThrow(SuppressionRefused);
      expect(await removeSuppression(db, organisationId, { id: "00000000-0000-0000-0000-000000000000" })).toBe(false);
    });
  });

  it("keeps one organisation's list to itself", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      await addSuppression(db, a.organisationId, { phone: "07700 900123" });
      expect(await listSuppressions(db, a.organisationId)).toHaveLength(1);
      expect(await listSuppressions(db, b.organisationId)).toHaveLength(0);
    });
  });
});
