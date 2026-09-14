import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq, isNull, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DEMO_PREFIX, DEMO_SLUG_PREFIX, removeDemoClients, seedDemoClients } from "./demo-client.js";
import { demoReference } from "./shared.js";

async function makeOrg(db: Db) {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: "LaunchFlow", slug: `lf-${crypto.randomUUID()}` })
    .returning();
  return org!;
}

/**
 * A fixed instant, so the relative dates in the seeders are deterministic.
 * Nothing here depends on the real clock, and a test that did would fail on
 * the one day of the year the arithmetic crossed a month boundary badly.
 */
const NOW = new Date("2026-09-14T12:00:00.000Z");

describe("seedDemoClients", () => {
  it("writes the three records, each at a different point in the pipeline", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const result = await seedDemoClients(db, org.id, NOW);

      // Suffixed with the organisation, because `brief_submissions.reference`
      // is unique globally rather than per organisation — so a flat
      // LF-DEMO-0001 could exist only once in a whole database.
      expect(result.delivered.reference).toMatch(/^LF-DEMO-[0-9a-f]{6}-0001$/);
      expect(result.inFlight.reference).toMatch(/^LF-DEMO-[0-9a-f]{6}-0002$/);
      expect(result.openLead.reference).toMatch(/^LF-DEMO-[0-9a-f]{6}-0003$/);

      // Two clients, because the open lead deliberately has none.
      const clients = await db
        .select({ slug: schema.clients.slug })
        .from(schema.clients)
        .where(and(eq(schema.clients.organisationId, org.id), like(schema.clients.slug, `${DEMO_SLUG_PREFIX}%`)));
      expect(clients.map((row) => row.slug).sort()).toEqual(["demo-riverside-dental", "demo-thameside-garage"]);

      const leads = await db
        .select({ status: schema.leads.status })
        .from(schema.leads)
        .where(and(eq(schema.leads.organisationId, org.id), like(schema.leads.name, `${DEMO_PREFIX}%`)));
      expect(leads.map((row) => row.status).sort()).toEqual(["converted", "converted", "qualified"]);

      const proposals = await db
        .select({ reference: schema.proposals.reference, status: schema.proposals.status })
        .from(schema.proposals)
        .where(eq(schema.proposals.organisationId, org.id));
      expect(proposals.map((row) => row.status).sort()).toEqual(["accepted", "accepted", "viewed"]);
    });
  });

  it("leaves the mid-build client genuinely mid-build", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { inFlight } = await seedDemoClients(db, org.id, NOW);

      const [project] = await db
        .select({ status: schema.projects.status, deliveredAt: schema.projects.deliveredAt })
        .from(schema.projects)
        .where(eq(schema.projects.id, inFlight.projectId));
      expect(project!.status).toBe("active");
      expect(project!.deliveredAt).toBeNull();

      // Two done, one active, three pending — the shape the progress spine
      // draws. A demo whose phases are all done cannot show progress at all.
      const phases = await db
        .select({ status: schema.projectPhases.status })
        .from(schema.projectPhases)
        .where(eq(schema.projectPhases.projectId, inFlight.projectId));
      const byStatus = phases.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {});
      expect(byStatus).toEqual({ done: 2, active: 1, pending: 3 });

      // Milestones still ahead, which is what a client's progress page is for.
      const unreached = await db
        .select({ title: schema.projectMilestones.title })
        .from(schema.projectMilestones)
        .where(and(eq(schema.projectMilestones.projectId, inFlight.projectId), isNull(schema.projectMilestones.reachedAt)));
      expect(unreached.length).toBe(4);

      const [site] = await db
        .select({ status: schema.sites.status })
        .from(schema.sites)
        .where(and(eq(schema.sites.organisationId, org.id), eq(schema.sites.clientId, inFlight.clientId)));
      expect(site!.status).toBe("building");

      const invoices = await db
        .select({ number: schema.invoices.number, status: schema.invoices.status, vatPence: schema.invoices.vatPence })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.organisationId, org.id), eq(schema.invoices.clientId, inFlight.clientId)));
      expect(invoices.map((row) => row.status).sort()).toEqual(["overdue", "paid"]);
      // LaunchFlow UK Limited is not VAT registered. A demo invoice showing
      // VAT is a demo of something that cannot happen.
      expect(invoices.every((row) => row.vatPence === 0)).toBe(true);

      const waiting = await db
        .select({ status: schema.contentItems.status })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.organisationId, org.id), eq(schema.contentItems.clientId, inFlight.clientId)));
      expect(waiting.filter((row) => row.status === "awaiting_approval").length).toBe(3);
    });
  });

  it("gives the open lead a live proposal and no client", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { openLead } = await seedDemoClients(db, org.id, NOW);

      const [proposal] = await db
        .select({
          status: schema.proposals.status,
          clientId: schema.proposals.clientId,
          decidedAt: schema.proposals.decidedAt,
          firstViewedAt: schema.proposals.firstViewedAt,
          validUntil: schema.proposals.validUntil,
        })
        .from(schema.proposals)
        .where(eq(schema.proposals.id, openLead.proposalId));

      expect(proposal!.status).toBe("viewed");
      expect(proposal!.clientId).toBeNull();
      expect(proposal!.decidedAt).toBeNull();
      expect(proposal!.firstViewedAt).not.toBeNull();
      // Still open: a proposal whose validity has passed shows as expired, and
      // an expired demo proposal demonstrates nothing.
      expect(new Date(`${proposal!.validUntil}T00:00:00.000Z`).getTime()).toBeGreaterThan(NOW.getTime());
    });
  });

  /**
   * The regression that cost two failed reseeds.
   *
   * The brief chain hangs off the lead, and deleting a lead nulls the
   * session's `lead_id` — so a remover that keys off the lead leaves a
   * submission nothing can find, and the next run dies on
   * `brief_submissions_reference`. Three runs rather than two because the
   * first failure only appeared on the second.
   */
  it("can be re-run repeatedly without colliding on a reference", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      await seedDemoClients(db, org.id, NOW);
      await seedDemoClients(db, org.id, NOW);
      const third = await seedDemoClients(db, org.id, NOW);

      expect(third.delivered.reference).toMatch(/^LF-DEMO-[0-9a-f]{6}-0001$/);

      const submissions = await db
        .select({ reference: schema.briefSubmissions.reference })
        .from(schema.briefSubmissions)
        .where(eq(schema.briefSubmissions.organisationId, org.id));
      expect(submissions.map((row) => row.reference).sort()).toEqual([
        demoReference(org.id, 1),
        demoReference(org.id, 2),
        demoReference(org.id, 3),
      ]);

      const clients = await db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(and(eq(schema.clients.organisationId, org.id), like(schema.clients.slug, `${DEMO_SLUG_PREFIX}%`)));
      expect(clients.length).toBe(2);
    });
  });

  it("removes every demo record, including the one with no client", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await seedDemoClients(db, org.id, NOW);

      const { removed } = await removeDemoClients(db, org.id);
      expect(removed).toBe(2);

      for (const rows of [
        await db.select().from(schema.clients).where(eq(schema.clients.organisationId, org.id)),
        await db.select().from(schema.leads).where(eq(schema.leads.organisationId, org.id)),
        await db.select().from(schema.proposals).where(eq(schema.proposals.organisationId, org.id)),
        await db.select().from(schema.briefSubmissions).where(eq(schema.briefSubmissions.organisationId, org.id)),
        await db.select().from(schema.briefSessions).where(eq(schema.briefSessions.organisationId, org.id)),
        await db.select().from(schema.invoices).where(eq(schema.invoices.organisationId, org.id)),
        await db.select().from(schema.contentItems).where(eq(schema.contentItems.organisationId, org.id)),
      ]) {
        expect(rows.length).toBe(0);
      }
    });
  });

  it("does not touch a real client that happens to sit beside the demo", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const [real] = await db
        .insert(schema.clients)
        .values({ organisationId: org.id, name: "AMO Rendering", slug: "amo-rendering" })
        .returning();
      await db.insert(schema.leads).values({ organisationId: org.id, name: "Ahmed Mohebi", email: "a@example.com" });

      await seedDemoClients(db, org.id, NOW);
      await removeDemoClients(db, org.id);

      const clients = await db.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.organisationId, org.id));
      expect(clients.map((row) => row.id)).toEqual([real!.id]);

      const leads = await db.select({ name: schema.leads.name }).from(schema.leads).where(eq(schema.leads.organisationId, org.id));
      expect(leads.map((row) => row.name)).toEqual(["Ahmed Mohebi"]);
    });
  });
  /**
   * Two tenants, one database. `brief_submissions.reference` is unique
   * globally, so before the organisation suffix the second organisation to
   * seed a demo failed on the first one's reference — a multi-tenancy bug in
   * a schema whose whole point is to be sellable as SaaS without a migration.
   */
  it("lets two organisations each have a demo in the same database", async () => {
    await withTestDb(async (db) => {
      const first = await makeOrg(db);
      const second = await makeOrg(db);

      const a = await seedDemoClients(db, first.id, NOW);
      const b = await seedDemoClients(db, second.id, NOW);

      expect(a.delivered.reference).not.toBe(b.delivered.reference);

      // And removing one tenant's demo leaves the other's alone.
      await removeDemoClients(db, first.id);
      const left = await db
        .select({ reference: schema.briefSubmissions.reference })
        .from(schema.briefSubmissions)
        .where(eq(schema.briefSubmissions.organisationId, second.id));
      expect(left).toHaveLength(3);
    });
  });
});
