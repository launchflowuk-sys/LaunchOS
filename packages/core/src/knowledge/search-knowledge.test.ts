import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { eq } from "drizzle-orm";
import { createKnowledgeArticle } from "./create-article.js";
import { deleteKnowledgeArticle } from "./delete-article.js";
import { searchKnowledge } from "./search-knowledge.js";
import { updateKnowledgeArticle } from "./update-article.js";

async function newOrg(db: Db) {
  const [o] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return o!;
}

describe("knowledge articles", () => {
  it("ranks a full-text match above an unrelated article and ignores unpublished ones", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const dns = await createKnowledgeArticle(db, o.id, {
        title: "DNS propagation", bodyMd: "Nameserver changes take up to 48 hours to propagate worldwide.",
        tags: ["dns"], published: true,
      });
      await createKnowledgeArticle(db, o.id, {
        title: "SSL renewal", bodyMd: "Certificates renew automatically 30 days before expiry.", tags: ["ssl"], published: true,
      });
      await createKnowledgeArticle(db, o.id, {
        title: "Draft nameserver notes", bodyMd: "Nameserver propagate propagate.", published: false,
      });

      const hits = await searchKnowledge(db, o.id, "nameserver propagation");
      expect(hits[0]!.id).toBe(dns.id);
      expect(hits.map((h) => h.title)).not.toContain("Draft nameserver notes");
      expect(hits[0]!.rank).toBeGreaterThan(0);
    });
  });

  it("derives a unique slug, updates the body and soft-deletes", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const created = await createKnowledgeArticle(db, o.id, { title: "Site Down Checklist", bodyMd: "Check hosting first.", published: true });
      expect(created.slug).toBe("site-down-checklist");

      const updated = await updateKnowledgeArticle(db, o.id, { articleId: created.id, bodyMd: "Check DNS first.", tags: ["hosting"] });
      expect(updated.bodyMd).toBe("Check DNS first.");
      expect(updated.tags).toEqual(["hosting"]);

      await deleteKnowledgeArticle(db, o.id, { articleId: created.id });
      const [row] = await db.select().from(schema.knowledgeArticles).where(eq(schema.knowledgeArticles.id, created.id));
      expect(row!.deletedAt).toBeInstanceOf(Date);
      expect(await searchKnowledge(db, o.id, "hosting")).toHaveLength(0);
    });
  });

  it("returns nothing rather than throwing for a query with no searchable words", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      await createKnowledgeArticle(db, o.id, { title: "T", bodyMd: "B", published: true });
      expect(await searchKnowledge(db, o.id, "   &&&   ")).toEqual([]);
    });
  });
});
