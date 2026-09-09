import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import type { KnowledgeAudience } from "@launchos/db/schema";
import { helpForRoute, routeCoverage } from "./help-for-route.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

async function article(
  db: Db,
  organisationId: string,
  over: { title: string; routes?: string[]; audiences?: KnowledgeAudience[]; published?: boolean },
) {
  const [row] = await db
    .insert(schema.knowledgeArticles)
    .values({
      organisationId,
      title: over.title,
      slug: `${over.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${crypto.randomUUID().slice(0, 6)}`,
      bodyMd: "1. Do the thing.",
      routes: over.routes ?? [],
      audiences: over.audiences ?? ["staff"],
      published: over.published ?? true,
    })
    .returning();
  return row!;
}

describe("helpForRoute", () => {
  it("gives a staff member the guides pinned to the screen they are on", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await article(db, org.id, { title: "Add a new client", routes: ["/clients"] });
      await article(db, org.id, { title: "Approve a post", routes: ["/approvals"] });

      const help = await helpForRoute(db, org.id, "/clients", "staff");
      expect(help.map((row) => row.title)).toEqual(["Add a new client"]);
    });
  });

  it("finds an article pinned to several screens from any of them", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await article(db, org.id, { title: "What a support address is", routes: ["/settings/email", "/clients", "/inbox"] });

      for (const route of ["/settings/email", "/clients", "/inbox"]) {
        expect(await helpForRoute(db, org.id, route, "staff")).toHaveLength(1);
      }
    });
  });

  /** A half-written guide is worse than none, because somebody will follow it. */
  it("never shows an unpublished draft", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await article(db, org.id, { title: "Half written", routes: ["/clients"], published: false });

      expect(await helpForRoute(db, org.id, "/clients", "staff")).toHaveLength(0);
    });
  });

  it("shows a reader only what was written for them", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await article(db, org.id, { title: "Owner only", routes: ["/clients"], audiences: ["admin"] });
      await article(db, org.id, { title: "For everyone here", routes: ["/clients"], audiences: ["admin", "staff"] });

      expect((await helpForRoute(db, org.id, "/clients", "staff")).map((r) => r.title)).toEqual(["For everyone here"]);
      expect((await helpForRoute(db, org.id, "/clients", "admin")).map((r) => r.title).sort())
        .toEqual(["For everyone here", "Owner only"]);
      expect(await helpForRoute(db, org.id, "/clients", "client")).toHaveLength(0);
    });
  });

  it("never reaches another organisation's guides", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      await article(db, theirs.id, { title: "Theirs", routes: ["/clients"] });

      expect(await helpForRoute(db, mine.id, "/clients", "staff")).toHaveLength(0);
    });
  });
});

describe("routeCoverage", () => {
  /**
   * The whole point: the rows that matter are the screens with nothing, and no
   * article mentions those.
   */
  it("reports a screen with no guide at all, which is the row that matters", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await article(db, org.id, { title: "Add a new client", routes: ["/clients"] });

      const coverage = await routeCoverage(db, org.id, ["/clients", "/domains", "/tasks"]);
      expect(coverage).toEqual([
        { route: "/clients", admin: 0, staff: 1, client: 0, total: 1 },
        { route: "/domains", admin: 0, staff: 0, client: 0, total: 0 },
        { route: "/tasks", admin: 0, staff: 0, client: 0, total: 0 },
      ]);
    });
  });

  it("counts each audience separately, so a screen covered for you but not for staff is visible", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await article(db, org.id, { title: "Deep billing detail", routes: ["/payments"], audiences: ["admin"] });

      const [row] = await routeCoverage(db, org.id, ["/payments"]);
      expect(row).toEqual({ route: "/payments", admin: 1, staff: 0, client: 0, total: 1 });
    });
  });

  it("does not count drafts as coverage", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await article(db, org.id, { title: "Draft", routes: ["/tasks"], published: false });

      expect((await routeCoverage(db, org.id, ["/tasks"]))[0]!.total).toBe(0);
    });
  });

  it("ignores an article pinned to a screen that is not being reported on", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await article(db, org.id, { title: "Elsewhere", routes: ["/somewhere-else"] });

      expect(await routeCoverage(db, org.id, ["/clients"])).toEqual([
        { route: "/clients", admin: 0, staff: 0, client: 0, total: 0 },
      ]);
    });
  });

  it("returns nothing when asked about nothing", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      expect(await routeCoverage(db, org.id, [])).toEqual([]);
    });
  });
});
