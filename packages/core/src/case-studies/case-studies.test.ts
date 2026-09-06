import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { createCaseStudy, ensureCaseStudyForProject, listCaseStudies, reorderCaseStudies, updateCaseStudy } from "./crud.js";
import { PORTFOLIO, PORTFOLIO_CLIENTS, PORTFOLIO_PRODUCTS } from "./portfolio.js";
import { toCaseStudySeed, toProduct, toWorkItem } from "./portfolio-view.js";
import { seedCaseStudies } from "./seed.js";
import { CaseStudyRefused, getCaseStudyBySlug } from "./shared.js";

const NOW = new Date("2026-09-07T10:00:00Z");

async function otherOrg(db: Db) {
  const [organisation] = await db.insert(schema.organisations)
    .values({ name: "Other", slug: `org-${randomUUID()}` }).returning();
  return organisation!.id;
}

describe("the portfolio seed", () => {
  it("reproduces every field of the marketing arrays after a round trip through the database", async () => {
    await withTestDb(async (db) => {
      const organisationId = await otherOrg(db);
      const { inserted, skipped } = await seedCaseStudies(db, organisationId, { now: NOW });
      expect(inserted).toHaveLength(PORTFOLIO.length);
      expect(skipped).toBe(0);

      const rows = await listCaseStudies(db, organisationId, { limit: 500 });
      // The whole point of the exercise: nothing Shoji wrote was paraphrased,
      // truncated or dropped on the way in. Compared as a whole array so an
      // entry going missing fails as loudly as a word changing.
      expect(rows.map(toCaseStudySeed)).toEqual(PORTFOLIO.map((entry) => ({ ...entry, stack: [...entry.stack], facts: [...entry.facts] })));

      // And back out in the two shapes the marketing pages render.
      const work = rows.filter((row) => row.kind === "client").map(toWorkItem);
      expect(work).toHaveLength(PORTFOLIO_CLIENTS.length);
      expect(work.map((item) => item.slug)).toEqual(PORTFOLIO_CLIENTS.map((entry) => entry.slug));
      const cabline = work.find((item) => item.slug === "grays-cabline")!;
      expect(cabline.client).toBe("Grays CabLine");
      expect(cabline.poweredBy?.name).toBe("Cabio");
      expect(cabline.brief.results).toContain("The dispatch side grew into Cabio");
      expect(cabline.screenshots).toEqual({ desktop: "/work/grays-cabline-desktop.jpg", mobile: "/work/grays-cabline-mobile.jpg" });
      // The badge is on all four taxi builds and on nothing else.
      expect(work.filter((item) => item.poweredBy).map((item) => item.slug))
        .toEqual(["grays-cabline", "lakeside-purfleet-taxis", "ockendon-station-taxis", "grays-town-taxis"]);
      expect(work.filter((item) => item.charity).map((item) => item.slug)).toEqual(["grays-park-masjid"]);

      const products = rows.filter((row) => row.kind === "product").map(toProduct);
      expect(products.map((product) => product.slug)).toEqual(PORTFOLIO_PRODUCTS.map((entry) => entry.slug));
      const cabio = products.find((product) => product.slug === "cabio")!;
      expect(cabio.domain).toBe("cabio.cab");
      expect(cabio.category).toBe("Transport");
      expect(cabio.flagship).toBe(true);
      expect(cabio.facts).toHaveLength(4);
    });
  });

  it("is idempotent, and never overwrites a story that has since been rewritten", async () => {
    await withTestDb(async (db) => {
      const organisationId = await otherOrg(db);
      await seedCaseStudies(db, organisationId, { now: NOW });
      const before = await getCaseStudyBySlug(db, organisationId, "farm-pizza");
      await updateCaseStudy(db, organisationId, {
        caseStudyId: before!.id, summary: "Rewritten by Shoji on a Sunday.", actorKind: "user",
      });

      const second = await seedCaseStudies(db, organisationId, { now: NOW });
      expect(second.inserted).toHaveLength(0);
      expect(second.skipped).toBe(PORTFOLIO.length);
      const after = await getCaseStudyBySlug(db, organisationId, "farm-pizza");
      expect(after!.summary).toBe("Rewritten by Shoji on a Sunday.");
      expect(await listCaseStudies(db, organisationId, { limit: 500 })).toHaveLength(PORTFOLIO.length);
    });
  });

  it("publishes everything it seeds, so deleting work.ts does not blank the Work page", async () => {
    await withTestDb(async (db) => {
      const organisationId = await otherOrg(db);
      await seedCaseStudies(db, organisationId, { now: NOW });
      const published = await listCaseStudies(db, organisationId, { status: "published", limit: 500 });
      expect(published).toHaveLength(PORTFOLIO.length);
      expect(published.every((row) => row.publishedAt !== null)).toBe(true);
      expect(published.map((row) => row.sort)).toEqual(PORTFOLIO.map((_, index) => index));
    });
  });

  it("audits every row it writes", async () => {
    await withTestDb(async (db) => {
      const organisationId = await otherOrg(db);
      await seedCaseStudies(db, organisationId, { now: NOW });
      const audits = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.action, "case_study.seeded")));
      expect(audits).toHaveLength(PORTFOLIO.length);
    });
  });
});

describe("case studies", () => {
  it("creates, edits and orders a story, stamping published_at once", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, clientId } = await seedOrgWithClient(db);
      const first = await createCaseStudy(db, organisationId, {
        clientId, name: "KD Essex Landscaping", sector: "Landscaping",
        summary: "Research first, then a site.", actorKind: "user", actorId: ownerUserId,
      });
      expect(first.slug).toBe("kd-essex-landscaping");
      expect(first.status).toBe("draft");
      expect(first.publishedAt).toBeNull();
      expect(first.sort).toBe(0);

      // A second story with the same name gets its own address rather than
      // colliding with the first: a slug is a public URL, not a name.
      const second = await createCaseStudy(db, organisationId, { clientId, name: "KD Essex Landscaping", actorKind: "user", actorId: ownerUserId });
      expect(second.slug).toBe("kd-essex-landscaping-2");
      expect(second.sort).toBe(1);

      const published = await updateCaseStudy(db, organisationId, {
        caseStudyId: first.id, status: "published", stack: ["Research", "BizzFlow"],
        brief: { client: "KD Essex", problem: "Nobody claims groundworks.", built: "A site on BizzFlow.", results: "Live." },
        actorKind: "user", actorId: ownerUserId, now: NOW,
      });
      expect(published.publishedAt?.toISOString()).toBe(NOW.toISOString());
      expect(published.stack).toEqual(["Research", "BizzFlow"]);

      // Unpublishing to fix a sentence must not make an old story look new.
      const hidden = await updateCaseStudy(db, organisationId, { caseStudyId: first.id, status: "unlisted", actorKind: "user", actorId: ownerUserId });
      const back = await updateCaseStudy(db, organisationId, {
        caseStudyId: first.id, status: "published", actorKind: "user", actorId: ownerUserId, now: new Date("2028-01-01T00:00:00Z"),
      });
      expect(hidden.publishedAt?.toISOString()).toBe(NOW.toISOString());
      expect(back.publishedAt?.toISOString()).toBe(NOW.toISOString());

      const reordered = await reorderCaseStudies(db, organisationId, { ids: [second.id, first.id], actorKind: "user", actorId: ownerUserId });
      expect(reordered.map((row) => row.slug)).toEqual([second.slug, first.slug]);
      expect((await listCaseStudies(db, organisationId, { limit: 10 })).map((row) => row.slug)).toEqual([second.slug, first.slug]);

      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.organisationId, organisationId));
      expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining([
        "case_study.created", "case_study.published", "case_study.unlisted", "case_study.reordered",
      ]));
    });
  });

  it("starts one draft per project and hands the same row back when asked twice", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const [project] = await db.insert(schema.projects)
        .values({ organisationId, clientId, name: "Website build" }).returning();

      const first = await ensureCaseStudyForProject(db, organisationId, {
        projectId: project!.id, clientId, name: "Website build", sector: "Landscaping",
      });
      const second = await ensureCaseStudyForProject(db, organisationId, {
        projectId: project!.id, clientId, name: "Website build", sector: "Landscaping",
      });
      expect(second.id).toBe(first.id);
      expect(first.status).toBe("draft");
      expect(first.deliveryStatus).toBe("in-build");
      expect(await listCaseStudies(db, organisationId, { clientId, limit: 10 })).toHaveLength(1);
    });
  });

  it("refuses to read or write another organisation's story", async () => {
    await withTestDb(async (db) => {
      const mine = await seedOrgWithClient(db);
      const theirs = await seedOrgWithClient(db);
      const study = await createCaseStudy(db, mine.organisationId, { clientId: mine.clientId, name: "Ours", actorKind: "user", actorId: mine.ownerUserId });

      expect(await getCaseStudyBySlug(db, theirs.organisationId, study.slug)).toBeNull();
      expect(await listCaseStudies(db, theirs.organisationId, { limit: 10 })).toHaveLength(0);
      await expect(updateCaseStudy(db, theirs.organisationId, { caseStudyId: study.id, name: "Stolen", actorKind: "user" }))
        .rejects.toThrow(CaseStudyRefused);
      expect(await reorderCaseStudies(db, theirs.organisationId, { ids: [study.id], actorKind: "user" })).toHaveLength(0);
      // The client on someone else's books is not a client of ours.
      await expect(createCaseStudy(db, theirs.organisationId, { clientId: mine.clientId, name: "Theirs", actorKind: "user" }))
        .rejects.toThrow(/not found in organisation/);
      expect((await getCaseStudyBySlug(db, mine.organisationId, study.slug))!.name).toBe("Ours");
    });
  });
});
