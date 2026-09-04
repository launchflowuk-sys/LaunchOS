import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { ensureEmailIdentity, supportAddress } from "./ensure-email-identity.js";

const ENV = { SUPPORT_EMAIL_DOMAIN: "support.test" };

describe("ensureEmailIdentity", () => {
  it("creates one identity per client and never audits the inbound secret", async () => {
    await withTestDb(async (db) => {
      const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
      const slug = `c-${crypto.randomUUID()}`;
      const [client] = await db.insert(schema.clients).values({ organisationId: org!.id, name: "C", slug }).returning();

      const identity = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, ENV);
      expect(identity.address).toBe(supportAddress(slug, "support.test"));
      expect(identity.inboundSecret).toMatch(/^[0-9a-f]{48}$/);

      // Idempotent: a second call returns the same row, not a second identity.
      const again = await ensureEmailIdentity(db, org!.id, { clientId: client!.id }, ENV);
      expect(again.id).toBe(identity.id);
      const rows = await db.select().from(schema.emailIdentities).where(eq(schema.emailIdentities.clientId, client!.id));
      expect(rows).toHaveLength(1);

      const [audit] = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, org!.id), eq(schema.auditLog.targetId, identity.id)));
      expect(audit).toBeDefined();
      const serialised = JSON.stringify(audit!.after);
      expect(serialised).not.toContain(identity.inboundSecret);
      expect(serialised).not.toContain("inboundSecret");
    });
  });
});
