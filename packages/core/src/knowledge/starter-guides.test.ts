import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { ensureStarterGuides } from "./ensure-starter-guides.js";
import { STARTER_GUIDES } from "./starter-guides.js";
import { routeCoverage } from "./help-for-route.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

const guidesOf = (db: Db, organisationId: string) =>
  db.select().from(schema.knowledgeArticles).where(eq(schema.knowledgeArticles.organisationId, organisationId));

describe("STARTER_GUIDES", () => {
  /** The whole point is coverage, so a screen missing from this list is the bug. */
  it("covers every screen in the sidebar exactly once", () => {
    const routes = STARTER_GUIDES.map((guide) => guide.route);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes.length).toBeGreaterThanOrEqual(38);
  });

  it("has a unique slug per guide, which is what makes seeding safe to repeat", () => {
    const slugs = STARTER_GUIDES.map((guide) => guide.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("names an audience and says something on every one", () => {
    for (const guide of STARTER_GUIDES) {
      expect(guide.audiences.length, guide.slug).toBeGreaterThan(0);
      expect(guide.body.trim().length, guide.slug).toBeGreaterThan(80);
      expect(guide.title.trim().length, guide.slug).toBeGreaterThan(0);
    }
  });

  /** Staff are who this is for; a set written only for the owner would miss the point. */
  it("is written mostly for staff", () => {
    const forStaff = STARTER_GUIDES.filter((guide) => guide.audiences.includes("staff"));
    expect(forStaff.length).toBeGreaterThan(STARTER_GUIDES.length / 2);
  });
});

describe("ensureStarterGuides", () => {
  it("installs one guide per screen, unpublished", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);

      const { added } = await ensureStarterGuides(db, org.id);

      expect(added).toBe(STARTER_GUIDES.length);
      const rows = await guidesOf(db, org.id);
      expect(rows).toHaveLength(STARTER_GUIDES.length);
      expect(rows.every((row) => row.published === false)).toBe(true);
      expect(rows.every((row) => row.routes.length === 1)).toBe(true);
    });
  });

  /** A deploy must not undo somebody's decision. */
  it("is safe to run twice, and never overwrites an edited guide", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await ensureStarterGuides(db, org.id);

      const first = STARTER_GUIDES[0]!;
      await db
        .update(schema.knowledgeArticles)
        .set({ bodyMd: "Shoji rewrote this", published: true })
        .where(eq(schema.knowledgeArticles.slug, first.slug));

      const second = await ensureStarterGuides(db, org.id);

      expect(second.added).toBe(0);
      const [edited] = await db
        .select()
        .from(schema.knowledgeArticles)
        .where(eq(schema.knowledgeArticles.slug, first.slug));
      expect(edited!.bodyMd).toBe("Shoji rewrote this");
      expect(edited!.published).toBe(true);
    });
  });

  /**
   * Coverage counts published guides only, so seeding alone must not make the
   * gaps list read zero — that would be a lie about what staff can actually
   * read.
   */
  it("leaves coverage at zero until somebody publishes them", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await ensureStarterGuides(db, org.id);

      const routes = STARTER_GUIDES.map((guide) => guide.route);
      const coverage = await routeCoverage(db, org.id, routes);
      expect(coverage.every((row) => row.total === 0)).toBe(true);

      await db.update(schema.knowledgeArticles).set({ published: true }).where(eq(schema.knowledgeArticles.organisationId, org.id));

      const after = await routeCoverage(db, org.id, routes);
      expect(after.every((row) => row.total === 1)).toBe(true);
      expect(after.filter((row) => row.staff > 0).length).toBeGreaterThan(routes.length / 2);
    });
  });

  it("never reaches another organisation", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      await ensureStarterGuides(db, mine.id);

      expect(await guidesOf(db, theirs.id)).toHaveLength(0);
    });
  });
});
