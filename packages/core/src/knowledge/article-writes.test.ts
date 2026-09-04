import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { createKnowledgeArticle } from "./create-article.js";
import { deleteKnowledgeArticle } from "./delete-article.js";
import { updateKnowledgeArticle } from "./update-article.js";

async function newOrg(db: Db) {
  const [o] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return o!;
}

async function auditFor(db: Db, organisationId: string, articleId: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.targetId, articleId)));
}

describe("knowledge article writes — audit actor", () => {
  it("names the actor that was passed on the create, update and delete audit rows", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const actorId = `user-${crypto.randomUUID()}`;

      const created = await createKnowledgeArticle(db, o.id, {
        title: "Actor trail", bodyMd: "Who did what.", published: true, actorId,
      });
      await updateKnowledgeArticle(db, o.id, { articleId: created.id, bodyMd: "Who did what, revised.", actorId });
      await deleteKnowledgeArticle(db, o.id, { articleId: created.id, actorId });

      const rows = await auditFor(db, o.id, created.id);
      const byAction = new Map(rows.map((row) => [row.action, row]));
      expect([...byAction.keys()].sort()).toEqual([
        "knowledge_article.created",
        "knowledge_article.deleted",
        "knowledge_article.updated",
      ]);
      for (const row of rows) {
        expect(row.actorKind).toBe("user");
        expect(row.actorId).toBe(actorId);
      }
    });
  });

  it("leaves the actor null rather than inventing one when a non-request caller omits it", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const created = await createKnowledgeArticle(db, o.id, { title: "Seeded", bodyMd: "No actor." });

      const [row] = await auditFor(db, o.id, created.id);
      expect(row!.action).toBe("knowledge_article.created");
      expect(row!.actorId).toBeNull();
    });
  });
});

describe("knowledge article writes — a soft delete is terminal", () => {
  it("refuses a second delete and leaves the original deletedAt untouched", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const created = await createKnowledgeArticle(db, o.id, { title: "Delete twice", bodyMd: "Body." });
      await deleteKnowledgeArticle(db, o.id, { articleId: created.id });

      const [afterFirst] = await db
        .select()
        .from(schema.knowledgeArticles)
        .where(eq(schema.knowledgeArticles.id, created.id));

      await expect(deleteKnowledgeArticle(db, o.id, { articleId: created.id })).rejects.toThrow(
        /not found in organisation/i,
      );

      const [afterSecond] = await db
        .select()
        .from(schema.knowledgeArticles)
        .where(eq(schema.knowledgeArticles.id, created.id));
      expect(afterSecond!.deletedAt).toEqual(afterFirst!.deletedAt);

      // The refused delete wrote no audit row of its own.
      const deletes = (await auditFor(db, o.id, created.id)).filter((r) => r.action === "knowledge_article.deleted");
      expect(deletes).toHaveLength(1);
    });
  });

  it("refuses an update to a deleted article", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const created = await createKnowledgeArticle(db, o.id, { title: "Edit after delete", bodyMd: "Body." });
      await deleteKnowledgeArticle(db, o.id, { articleId: created.id });

      await expect(
        updateKnowledgeArticle(db, o.id, { articleId: created.id, bodyMd: "Resurrected." }),
      ).rejects.toThrow(/not found in organisation/i);

      const [row] = await db.select().from(schema.knowledgeArticles).where(eq(schema.knowledgeArticles.id, created.id));
      expect(row!.bodyMd).toBe("Body.");
    });
  });

  it("refuses to publish a deleted article — publishing is an update like any other", async () => {
    await withTestDb(async (db) => {
      const o = await newOrg(db);
      const created = await createKnowledgeArticle(db, o.id, { title: "Publish after delete", bodyMd: "Body." });
      await deleteKnowledgeArticle(db, o.id, { articleId: created.id });

      await expect(
        updateKnowledgeArticle(db, o.id, { articleId: created.id, published: true }),
      ).rejects.toThrow(/not found in organisation/i);

      const [row] = await db.select().from(schema.knowledgeArticles).where(eq(schema.knowledgeArticles.id, created.id));
      expect(row!.published).toBe(false);
    });
  });
});
