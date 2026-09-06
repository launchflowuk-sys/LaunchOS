import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { convertLeadToClient, createLead, getLead, listLeads, updateLeadStatus } from "./leads.js";

describe("leads", () => {
  it("creates with bounded fields, bells the owner urgently, lists newest first with a total and a status filter", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId } = await seedOrgWithClient(db);
      const first = await createLead(db, organisationId, {
        name: "  Aisha Khan ", email: "Aisha@Example.Test", business: "Khan Dental", message: "Need a website", source: "website",
        metadata: { page: "/contact" }, actorKind: "client",
      });
      expect(first).toMatchObject({ name: "Aisha Khan", email: "aisha@example.test", business: "Khan Dental", status: "new", source: "website", metadata: { page: "/contact" } });
      const second = await createLead(db, organisationId, { name: "Bob", phone: "07700 900000", notifyOwner: false });

      const [bell] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ownerUserId), eq(schema.notifications.kind, "lead.created")));
      expect(bell?.title).toBe("New lead: Khan Dental");
      expect(bell?.link).toBe(`/leads/${first.id}`);
      expect(await db.select().from(schema.notifications).where(eq(schema.notifications.kind, "lead.created")).then((r) => r.filter((n) => n.link === `/leads/${second.id}`))).toHaveLength(0);

      await db.update(schema.leads).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(schema.leads.id, first.id));
      const all = await listLeads(db, organisationId);
      expect(all.total).toBe(2);
      expect(all.leads.map((l) => l.id)).toEqual([second.id, first.id]);
      await updateLeadStatus(db, organisationId, { leadId: second.id, status: "lost", actorId: ownerUserId });
      expect((await listLeads(db, organisationId, { status: "new" })).leads.map((l) => l.id)).toEqual([first.id]);
      await expect(createLead(db, organisationId, { name: "", source: "x" })).rejects.toThrow();
    });
  });

  it("converts once into a client with the lead's details and refuses again; status cannot be set to converted by hand", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, packageId } = await seedOrgWithClient(db);
      const lead = await createLead(db, organisationId, { name: "Aisha", email: "aisha@example.test", phone: "0770", business: "Khan Dental", message: "Hi", source: "website" });
      await expect(updateLeadStatus(db, organisationId, { leadId: lead.id, status: "converted", actorId: ownerUserId })).rejects.toThrow(/convertLeadToClient/);

      const { lead: converted, client } = await convertLeadToClient(db, organisationId, { leadId: lead.id, actorId: ownerUserId, packageId });
      expect(client).toMatchObject({ name: "Khan Dental", email: "aisha@example.test", phone: "0770", packageId, organisationId });
      expect(client.notes).toContain("From lead (website): Hi");
      expect(converted).toMatchObject({ status: "converted", clientId: client.id });
      await expect(convertLeadToClient(db, organisationId, { leadId: lead.id, actorId: ownerUserId })).rejects.toThrow(/already been converted/);
      await expect(updateLeadStatus(db, organisationId, { leadId: lead.id, status: "lost", actorId: ownerUserId })).rejects.toThrow(/converted lead/);

      const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.targetId, lead.id)));
      expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["lead.created", "lead.converted"]));
      const [timeline] = await db.select().from(schema.activityEvents).where(and(eq(schema.activityEvents.clientId, client.id), eq(schema.activityEvents.kind, "lead.converted")));
      expect(timeline?.link).toBe(`/leads/${lead.id}`);
    });
  });

  it("keeps organisations apart", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const lead = await createLead(db, a.organisationId, { name: "Only A" });
      expect(await getLead(db, b.organisationId, lead.id)).toBeNull();
      expect((await listLeads(db, b.organisationId)).total).toBe(0);
      await expect(updateLeadStatus(db, b.organisationId, { leadId: lead.id, status: "contacted", actorId: b.ownerUserId })).rejects.toThrow(/not found in organisation/);
      await expect(convertLeadToClient(db, b.organisationId, { leadId: lead.id, actorId: b.ownerUserId })).rejects.toThrow(/not found in organisation/);
      await expect(convertLeadToClient(db, a.organisationId, { leadId: lead.id, actorId: a.ownerUserId, packageId: b.packageId })).rejects.toThrow(/not found in organisation/);
    });
  });
});
