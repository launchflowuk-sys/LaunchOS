import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { BriefTooThin, briefFromLead, missingFromBrief } from "./brief-from-lead.js";

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

async function lead(db: Db, organisationId: string, over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(schema.leads)
    .values({
      organisationId,
      name: "Sam Taylor",
      business: "Taylor Plumbing",
      source: "website-wizard",
      qualification: {
        industry: "Plumbing and heating",
        services: "Boiler servicing\nBathroom installation",
        serviceArea: "Grays and across Thurrock",
        goals: "More emergency callouts",
        websiteUrl: "taylorplumbing.test",
      },
      ...over,
    })
    .returning();
  return row!;
}

describe("missingFromBrief", () => {
  /** Without something about what they do, the model invents it. */
  it("needs a name and something about what they do", () => {
    expect(missingFromBrief({ services: "Boilers" }, "Taylor Plumbing")).toEqual([]);
    expect(missingFromBrief({ industry: "Plumbing" }, "Taylor Plumbing")).toEqual([]);
    expect(missingFromBrief({}, "Taylor Plumbing")).toEqual(["services or industry"]);
    expect(missingFromBrief({ services: "Boilers" }, null)).toEqual(["business name"]);
    expect(missingFromBrief({}, "  ")).toEqual(["business name", "services or industry"]);
  });
});

describe("briefFromLead", () => {
  it("turns the wizard's answers into a brief with no retyping", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await lead(db, org.id);

      const { brief } = await briefFromLead(db, org.id, row.id);

      expect(brief).toEqual({
        businessName: "Taylor Plumbing",
        industry: "Plumbing and heating",
        services: "Boiler servicing\nBathroom installation",
        serviceArea: "Grays and across Thurrock",
        goals: "More emergency callouts",
        existingUrl: "taylorplumbing.test",
      });
    });
  });

  /** A sole trader often gives their own name and means the business. */
  it("falls back to the person's name when no business name was given", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await lead(db, org.id, { business: null });

      expect((await briefFromLead(db, org.id, row.id)).brief.businessName).toBe("Sam Taylor");
    });
  });

  /**
   * The refusal that matters. A site built from nothing is three paragraphs of
   * invention on somebody's real business.
   */
  it("refuses a lead who said nothing about what they do, and names what is missing", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await lead(db, org.id, { qualification: {} });

      await expect(briefFromLead(db, org.id, row.id)).rejects.toThrow(BriefTooThin);
      await expect(briefFromLead(db, org.id, row.id)).rejects.toThrow(/services or industry/);
    });
  });

  it("survives a row whose qualification predates a field", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await lead(db, org.id, { qualification: { industry: "Plumbing", somethingRetired: 42 } });

      const { brief } = await briefFromLead(db, org.id, row.id);
      expect(brief.industry).toBe("Plumbing");
      expect(brief).not.toHaveProperty("somethingRetired");
    });
  });

  it("never reads another organisation's lead", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      const row = await lead(db, theirs.id);

      await expect(briefFromLead(db, mine.id, row.id)).rejects.toThrow(/could not be found/);
    });
  });
});
