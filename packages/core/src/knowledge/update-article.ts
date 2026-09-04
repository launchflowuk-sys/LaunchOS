import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

export const UpdateKnowledgeArticleInput = z.object({
  articleId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  bodyMd: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  published: z.boolean().optional(),
  // Audit actor; never written to the article row itself.
  actorId: z.string().optional(),
});
export type UpdateKnowledgeArticleInput = z.input<typeof UpdateKnowledgeArticleInput>;

export async function updateKnowledgeArticle(db: Db, organisationId: string, input: UpdateKnowledgeArticleInput) {
  const { articleId, actorId, ...patch } = UpdateKnowledgeArticleInput.parse(input);
  await assertOwned(db, organisationId, schema.knowledgeArticles, articleId);
  // `assertOwned` has no soft-delete filter, so the `isNull` here is what keeps
  // a deleted article deleted: a direct POST carrying its id finds no row and
  // is reported as missing rather than editing something nobody can see.
  const where = and(
    eq(schema.knowledgeArticles.id, articleId),
    eq(schema.knowledgeArticles.organisationId, organisationId),
    isNull(schema.knowledgeArticles.deletedAt),
  );

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.knowledgeArticles).where(where);
    const [after] = await tx
      .update(schema.knowledgeArticles)
      .set({ ...patch, updatedAt: new Date() })
      .where(where)
      .returning();
    if (!after) throw new Error(`knowledge_article ${articleId} not found in organisation`);
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: "user", actorId, action: "knowledge_article.updated", targetType: "knowledge_article", targetId: articleId, before, after,
    });
    return after;
  });
}
