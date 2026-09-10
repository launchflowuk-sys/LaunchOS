import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { abandonedWithHosting, activeSiteBuilds, advanceSiteBuild, startSiteBuild } from "./site-builds.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

const DOMAIN = "taylor-plumbing.review.launchflow.co.uk";

describe("startSiteBuild", () => {
  it("starts a build and records that it did", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const { build, created } = await startSiteBuild(db, org.id, { domain: DOMAIN, actorId: "u1" });

      expect(created).toBe(true);
      expect(build.stage).toBe("queued");
      expect(build.domain).toBe(DOMAIN);
      const audits = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, org.id), eq(schema.auditLog.action, "site_build.started")));
      expect(audits).toHaveLength(1);
    });
  });

  /**
   * A person pressing twice and a job retrying look identical from here, and
   * neither should produce a second build against the same hosting.
   */
  it("hands back the existing build rather than starting a second on one domain", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const first = await startSiteBuild(db, org.id, { domain: DOMAIN });

      const second = await startSiteBuild(db, org.id, { domain: DOMAIN });

      expect(second.created).toBe(false);
      expect(second.build.id).toBe(first.build.id);
    });
  });

  it("lower-cases the domain, so two spellings are not two builds", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const a = await startSiteBuild(db, org.id, { domain: DOMAIN.toUpperCase() });
      const b = await startSiteBuild(db, org.id, { domain: DOMAIN });
      expect(b.build.id).toBe(a.build.id);
    });
  });
});

describe("advanceSiteBuild", () => {
  it("moves through the stages, stamping each from the stage itself", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { build } = await startSiteBuild(db, org.id, { domain: DOMAIN });

      await advanceSiteBuild(db, org.id, build.id, "provisioning", { hostingUsername: "u509477357" });
      const review = await advanceSiteBuild(db, org.id, build.id, "review", {
        websiteUrl: `https://${DOMAIN}`,
        adminUrl: `https://${DOMAIN}/wp-admin`,
      });
      expect(review.reviewReadyAt).not.toBeNull();
      expect(review.approvedAt).toBeNull();

      const approved = await advanceSiteBuild(db, org.id, build.id, "approved", {}, "u1");
      expect(approved.approvedAt).not.toBeNull();
      expect(approved.notifiedAt).toBeNull();

      const notified = await advanceSiteBuild(db, org.id, build.id, "notified");
      expect(notified.notifiedAt).not.toBeNull();
    });
  });

  it("keeps the words of a failure, and clears them when it moves on", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { build } = await startSiteBuild(db, org.id, { domain: DOMAIN });

      const failed = await advanceSiteBuild(db, org.id, build.id, "failed", {
        error: "POST /hosting/v1/websites → 422: domain field is required",
      });
      expect(failed.error).toContain("422");

      // A retry must not leave the old error reading as the current state.
      const retried = await advanceSiteBuild(db, org.id, build.id, "provisioning");
      expect(retried.error).toBeNull();
    });
  });

  it("audits every stage, so a build that reached a client can be accounted for", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { build } = await startSiteBuild(db, org.id, { domain: DOMAIN });
      await advanceSiteBuild(db, org.id, build.id, "review");
      await advanceSiteBuild(db, org.id, build.id, "approved", {}, "u1");

      const audits = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, org.id), eq(schema.auditLog.targetType, "site_build")));
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining(["site_build.started", "site_build.review", "site_build.approved"]),
      );
    });
  });

  it("refuses another organisation's build", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      const { build } = await startSiteBuild(db, theirs.id, { domain: DOMAIN });

      await expect(advanceSiteBuild(db, mine.id, build.id, "review")).rejects.toThrow(/could not be found/);
    });
  });
});

describe("activeSiteBuilds", () => {
  it("lists what is still on its way, and leaves finished ones out", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const going = await startSiteBuild(db, org.id, { domain: "a.review.test" });
      const done = await startSiteBuild(db, org.id, { domain: "b.review.test" });
      await advanceSiteBuild(db, org.id, done.build.id, "notified");

      const active = await activeSiteBuilds(db, org.id);
      expect(active.map((row) => row.id)).toEqual([going.build.id]);
    });
  });

  it("counts a build waiting on a person as still active", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { build } = await startSiteBuild(db, org.id, { domain: DOMAIN });
      await advanceSiteBuild(db, org.id, build.id, "review");

      expect((await activeSiteBuilds(db, org.id)).map((r) => r.id)).toEqual([build.id]);
    });
  });
});

describe("abandonedWithHosting", () => {
  /** The orphan list. Nothing else will ever remove a website these left behind. */
  it("finds failed builds that got as far as creating hosting", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const withHosting = await startSiteBuild(db, org.id, { domain: "a.review.test" });
      await advanceSiteBuild(db, org.id, withHosting.build.id, "failed", {
        hostingUsername: "u509477357", error: "install timed out",
      });

      const early = await startSiteBuild(db, org.id, { domain: "b.review.test" });
      await advanceSiteBuild(db, org.id, early.build.id, "failed", { error: "the model refused" });

      const orphans = await abandonedWithHosting(db, org.id);
      expect(orphans.map((row) => row.domain)).toEqual(["a.review.test"]);
    });
  });

  it("includes a build somebody cancelled, because the website is still there", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const { build } = await startSiteBuild(db, org.id, { domain: DOMAIN });
      await advanceSiteBuild(db, org.id, build.id, "cancelled", { hostingUsername: "u1" });

      expect(await abandonedWithHosting(db, org.id)).toHaveLength(1);
    });
  });
});
