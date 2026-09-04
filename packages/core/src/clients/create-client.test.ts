import { beforeEach, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { archiveClient, updateClient } from "./update-client.js";
import { createClient } from "./create-client.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("createClient", () => {
  const events: DomainEvent[] = [];
  beforeEach(() => {
    events.length = 0;
    process.env.SUPPORT_EMAIL_DOMAIN = "support.launchflow.test";
    setEnqueue(async (event) => { events.push(event); });
  });

  it("derives a unique slug and support email, opens a billing profile, logs the timeline and emits client.created", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const first = await createClient(db, org.id, {
        name: "Grays CabLine", email: "info@grayscabline.co.uk", phone: "01375 000000",
        addressLine1: "1 High Street", city: "Grays", postcode: "RM17 6AA", actorKind: "user", actorId: "u1",
      });
      expect(first.slug).toBe("grays-cabline");
      expect(first.supportEmail).toBe("grays-cabline@support.launchflow.test");
      expect(first.country).toBe("GB");

      const second = await createClient(db, org.id, { name: "Grays CabLine" });
      expect(second.slug).toBe("grays-cabline-2");
      expect(second.supportEmail).toBe("grays-cabline-2@support.launchflow.test");

      const [billing] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, first.id));
      expect(billing?.paymentTermsDays).toBe(14);

      const timeline = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.clientId, first.id));
      expect(timeline.map((e) => e.kind)).toEqual(["client.created"]);
      expect(timeline[0]!.actorId).toBe("u1");

      expect(events).toEqual([
        { name: "client.created", organisationId: org.id, clientId: first.id },
        { name: "client.created", organisationId: org.id, clientId: second.id },
      ]);
    });
  });

  it("updates fields and archives without touching the slug", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Acme" });

      const updated = await updateClient(db, org.id, {
        clientId: client.id, city: "Grays", industry: "Retail", actorKind: "user", actorId: "u1",
      });
      expect(updated.city).toBe("Grays");
      expect(updated.slug).toBe(client.slug);
      expect(updated.supportEmail).toBe(client.supportEmail);

      const archived = await archiveClient(db, org.id, { clientId: client.id, actorKind: "user", actorId: "u1" });
      expect(archived.status).toBe("archived");
    });
  });

  it("keeps support emails globally unique across organisations", async () => {
    await withTestDb(async (db) => {
      const orgA = await makeOrg(db);
      const orgB = await makeOrg(db);

      const a = await createClient(db, orgA.id, { name: "Acme Ltd" });
      const b = await createClient(db, orgB.id, { name: "Acme Ltd" });

      expect(a.slug).toBe("acme-ltd");
      expect(b.slug).toBe("acme-ltd-2");
      expect(a.supportEmail).toBe("acme-ltd@support.launchflow.test");
      expect(b.supportEmail).toBe("acme-ltd-2@support.launchflow.test");
      expect(a.supportEmail).not.toBe(b.supportEmail);
    });
  });
});
