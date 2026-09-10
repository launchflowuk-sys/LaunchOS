import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { startSiteBuild } from "@launchos/core";
import { MockHostingProvisioner, MockSiteGenerator, MockSiteUploader } from "@launchos/integrations";
import { runSiteBuilds, type SiteBuildDeps } from "./site-build-run.js";

const silent = { info: () => {}, error: () => {} };
const DOMAIN = "taylor-plumbing.review.test";

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  const ownerId = crypto.randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner", status: "active" });

  const [lead] = await db.insert(schema.leads).values({
    organisationId: org!.id, name: "Sam Taylor", business: "Taylor Plumbing", source: "website-wizard",
    qualification: { industry: "Plumbing and heating", services: "Boiler servicing\nBathroom installation" },
  }).returning();

  return { organisationId: org!.id, leadId: lead!.id };
}

function deps(db: Db): SiteBuildDeps & { uploader: MockSiteUploader; host: MockHostingProvisioner } {
  const uploader = new MockSiteUploader();
  const host = new MockHostingProvisioner(1);
  return {
    db, host, uploader,
    generator: new MockSiteGenerator(),
    orderId: 1007850501,
    makeAdminPassword: () => "a-generated-password",
    logger: silent,
  };
}

/** One stage per tick, so a full chain takes several. */
async function tickUntilSettled(d: SiteBuildDeps, organisationId: string, times = 8) {
  for (let i = 0; i < times; i += 1) {
    await runSiteBuilds(d, organisationId);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const buildOf = async (db: Db, organisationId: string) =>
  (await db.select().from(schema.siteBuilds).where(eq(schema.siteBuilds.organisationId, organisationId)))[0]!;

describe("runSiteBuilds", () => {
  it("carries a build from queued to review, and stops there", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const d = deps(db);
      await startSiteBuild(db, f.organisationId, { domain: DOMAIN, leadId: f.leadId });

      await tickUntilSettled(d, f.organisationId);

      const build = await buildOf(db, f.organisationId);
      expect(build.stage).toBe("review");
      expect(build.websiteUrl).toContain(DOMAIN);
      expect(build.adminUrl).toContain("/wp-admin");
      expect(build.rootDirectory).toContain("public_html");
      expect(build.generatorModel).toBe("mock");
      expect(build.reviewReadyAt).not.toBeNull();
    });
  });

  /** The whole point: built, working, and the client told nothing. */
  it("does not move past review on its own", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const d = deps(db);
      await startSiteBuild(db, f.organisationId, { domain: DOMAIN, leadId: f.leadId });
      await tickUntilSettled(d, f.organisationId);

      const result = await runSiteBuilds(d, f.organisationId);

      expect(result.awaitingReview).toBe(1);
      expect(result.advanced).toBe(0);
      expect((await buildOf(db, f.organisationId)).notifiedAt).toBeNull();
    });
  });

  it("uploads the generated pages into the document root", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const d = deps(db);
      await startSiteBuild(db, f.organisationId, { domain: DOMAIN, leadId: f.leadId });

      await tickUntilSettled(d, f.organisationId);

      const written = [...d.uploader.written.entries()];
      expect(written).toHaveLength(1);
      const [root, files] = written[0]!;
      expect(root).toContain(DOMAIN);
      expect(files.map((file) => file.path)).toEqual(
        expect.arrayContaining(["index.html", "contact/index.html", "style.css"]),
      );
      expect(files.find((file) => file.path === "index.html")!.contents).toContain("Taylor Plumbing");
    });
  });

  it("rings the owner once it is ready to look at, saying nothing went to the client", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await startSiteBuild(db, f.organisationId, { domain: DOMAIN, leadId: f.leadId });

      await tickUntilSettled(deps(db), f.organisationId);

      const [bell] = await db.select().from(schema.notifications).where(and(
        eq(schema.notifications.organisationId, f.organisationId),
        eq(schema.notifications.kind, "site_build.review"),
      ));
      expect(bell!.title).toContain(DOMAIN);
      expect(bell!.body).toContain("Nothing has been sent to the client");
    });
  });

  /** A failure has to leave the row saying where it stopped, or the site is an orphan. */
  it("records a failure on the row rather than throwing, keeping the hosting findable", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const d = deps(db);
      // A lead with nothing to build from: the brief refuses, as it should.
      await db.update(schema.leads).set({ qualification: {}, business: null, name: "" })
        .where(eq(schema.leads.id, f.leadId));
      await startSiteBuild(db, f.organisationId, { domain: DOMAIN, leadId: f.leadId });

      await tickUntilSettled(d, f.organisationId, 3);

      const build = await buildOf(db, f.organisationId);
      expect(build.stage).toBe("failed");
      expect(build.error).toBeTruthy();
    });
  });

  it("one failing build does not stop another", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const d = deps(db);
      const [orphanLead] = await db.insert(schema.leads).values({
        organisationId: f.organisationId, name: "", source: "manual", qualification: {},
      }).returning();

      await startSiteBuild(db, f.organisationId, { domain: "good.review.test", leadId: f.leadId });
      await startSiteBuild(db, f.organisationId, { domain: "bad.review.test", leadId: orphanLead!.id });

      await tickUntilSettled(d, f.organisationId);

      const rows = await db.select().from(schema.siteBuilds).where(eq(schema.siteBuilds.organisationId, f.organisationId));
      expect(rows.find((r) => r.domain === "good.review.test")!.stage).toBe("review");
      expect(rows.find((r) => r.domain === "bad.review.test")!.stage).toBe("failed");
    });
  });
});
